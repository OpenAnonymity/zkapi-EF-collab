//! Ethereum JSON-RPC log poller for the indexer.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use zkapi_types::Felt252;

use crate::events::VaultEvent;
use crate::service::IndexerService;

#[derive(Debug, Clone)]
pub struct PollerConfig {
    pub rpc_url: String,
    pub contract_address: String,
    pub from_block: u64,
    pub cursor_path: Option<String>,
}

impl Default for PollerConfig {
    fn default() -> Self {
        Self {
            rpc_url: "http://127.0.0.1:8545".to_string(),
            contract_address: "0x0000000000000000000000000000000000000000".to_string(),
            from_block: 0,
            cursor_path: Some("zkapi-indexer.cursor".to_string()),
        }
    }
}

pub struct JsonRpcLogPoller {
    client: Client,
    rpc_url: String,
    contract_address: String,
    next_from_block: u64,
    cursor_path: Option<PathBuf>,
}

impl JsonRpcLogPoller {
    pub fn new(config: PollerConfig) -> anyhow::Result<Self> {
        let next_from_block = match config.cursor_path.as_deref() {
            Some(path) => load_cursor(Path::new(path))?.map(|last| last.saturating_add(1)),
            None => None,
        }
        .unwrap_or(config.from_block);

        Ok(Self {
            client: Client::new(),
            rpc_url: config.rpc_url,
            contract_address: normalize_address(&config.contract_address)?,
            next_from_block,
            cursor_path: config.cursor_path.map(PathBuf::from),
        })
    }

    pub fn next_from_block(&self) -> u64 {
        self.next_from_block
    }

    pub async fn poll_once(&mut self, service: &IndexerService) -> anyhow::Result<usize> {
        let latest_block = self.fetch_block_number().await?;
        if latest_block < self.next_from_block {
            return Ok(0);
        }

        let logs = self.fetch_logs(self.next_from_block, latest_block).await?;
        let mut applied = 0usize;
        for log in logs {
            let Some((event, expected_root)) = decode_log(&log)? else {
                continue;
            };
            service.process_event(&event);
            applied += 1;

            if let Some(expected_root) = expected_root {
                let actual_root = service.get_root();
                if actual_root != expected_root {
                    tracing::warn!(
                        expected = %expected_root,
                        actual = %actual_root,
                        block = %log.block_number,
                        "indexer mirror root diverged from contract event root"
                    );
                }
            }
        }

        self.next_from_block = latest_block.saturating_add(1);
        self.persist_cursor(latest_block)?;
        Ok(applied)
    }

    async fn fetch_block_number(&self) -> anyhow::Result<u64> {
        let result: String = self.rpc("eth_blockNumber", serde_json::json!([])).await?;
        parse_hex_u64(&result)
    }

    async fn fetch_logs(&self, from_block: u64, to_block: u64) -> anyhow::Result<Vec<RpcLog>> {
        let filter = serde_json::json!([{
            "address": &self.contract_address,
            "fromBlock": format!("0x{:x}", from_block),
            "toBlock": format!("0x{:x}", to_block),
        }]);
        self.rpc("eth_getLogs", filter).await
    }

    async fn rpc<T: DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<T> {
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            method: method.to_string(),
            params,
            id: 1u64,
        };
        let response = self
            .client
            .post(&self.rpc_url)
            .json(&request)
            .send()
            .await
            .with_context(|| format!("rpc call to {} failed", self.rpc_url))?
            .error_for_status()
            .context("rpc call returned non-success status")?;
        let body: JsonRpcResponse<T> = response.json().await.context("invalid rpc response")?;
        if let Some(error) = body.error {
            return Err(anyhow!("rpc error {}: {}", error.code, error.message));
        }
        body.result
            .ok_or_else(|| anyhow!("rpc response missing result"))
    }

    fn persist_cursor(&self, last_processed_block: u64) -> anyhow::Result<()> {
        let Some(path) = &self.cursor_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create cursor dir {}", parent.display()))?;
        }
        fs::write(path, last_processed_block.to_string())
            .with_context(|| format!("failed to write cursor file {}", path.display()))
    }
}

pub fn spawn_json_rpc_log_poller(
    service: Arc<IndexerService>,
    config: PollerConfig,
    interval: Duration,
) {
    tokio::spawn(async move {
        let mut poller = match JsonRpcLogPoller::new(config) {
            Ok(poller) => poller,
            Err(err) => {
                tracing::error!("failed to initialize indexer poller: {}", err);
                return;
            }
        };
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            if let Err(err) = poller.poll_once(&service).await {
                tracing::warn!("indexer rpc poll failed: {}", err);
            }
        }
    });
}

#[derive(Debug, Clone, Deserialize)]
pub struct RpcLog {
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    pub data: String,
    pub topics: Vec<String>,
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    method: String,
    params: serde_json::Value,
    id: u64,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse<T> {
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

fn load_cursor(path: &Path) -> anyhow::Result<Option<u64>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("failed to read cursor file {}", path.display()))?;
    Ok(Some(raw.trim().parse::<u64>().with_context(|| {
        format!("invalid cursor value in {}", path.display())
    })?))
}

fn normalize_address(address: &str) -> anyhow::Result<String> {
    let trimmed = address.trim();
    let raw = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if raw.is_empty() || raw.len() > 40 {
        return Err(anyhow!("contract address must be 20-byte hex"));
    }
    let normalized = format!("{raw:0>40}").to_ascii_lowercase();
    hex::decode(&normalized).context("contract address is not valid hex")?;
    Ok(format!("0x{normalized}"))
}

fn decode_log(log: &RpcLog) -> anyhow::Result<Option<(VaultEvent, Option<Felt252>)>> {
    let Some(topic0) = log.topics.first() else {
        return Ok(None);
    };
    let data_words = split_words(&log.data)?;

    match topic0.as_str() {
        topic if topic == event_topic("NoteDeposited(uint32,bytes32,uint128,uint64,uint256)") => {
            if log.topics.len() < 3 || data_words.len() != 3 {
                return Err(anyhow!("malformed NoteDeposited log"));
            }
            let note_id = topic_to_u32(&log.topics[1])?;
            let commitment = topic_to_felt(&log.topics[2])?;
            let amount = word_to_u128(&data_words[0]);
            let expiry_ts = word_to_u64(&data_words[1]);
            let new_root = word_to_felt(&data_words[2]);
            Ok(Some((
                VaultEvent::NoteDeposited {
                    note_id,
                    commitment,
                    amount,
                    expiry_ts,
                    new_root,
                },
                Some(new_root),
            )))
        }
        topic if topic == event_topic("MutualClose(uint32,uint256,uint128,address)") => {
            if log.topics.len() < 2 || data_words.len() != 3 {
                return Err(anyhow!("malformed MutualClose log"));
            }
            Ok(Some((
                VaultEvent::MutualClose {
                    note_id: topic_to_u32(&log.topics[1])?,
                    nullifier: word_to_felt(&data_words[0]),
                    final_balance: word_to_u128(&data_words[1]),
                },
                None,
            )))
        }
        topic
            if topic
                == event_topic(
                    "EscapeWithdrawalInitiated(uint32,uint256,uint128,address,uint64,uint256)",
                ) =>
        {
            if log.topics.len() < 2 || data_words.len() != 5 {
                return Err(anyhow!("malformed EscapeWithdrawalInitiated log"));
            }
            let new_root = word_to_felt(&data_words[4]);
            Ok(Some((
                VaultEvent::EscapeWithdrawalInitiated {
                    note_id: topic_to_u32(&log.topics[1])?,
                    nullifier: word_to_felt(&data_words[0]),
                    final_balance: word_to_u128(&data_words[1]),
                    challenge_deadline: word_to_u64(&data_words[3]),
                    new_root,
                },
                Some(new_root),
            )))
        }
        topic if topic == event_topic("EscapeWithdrawalChallenged(uint32,uint256,uint256)") => {
            if log.topics.len() < 2 || data_words.len() != 2 {
                return Err(anyhow!("malformed EscapeWithdrawalChallenged log"));
            }
            let restored_root = word_to_felt(&data_words[1]);
            Ok(Some((
                VaultEvent::EscapeWithdrawalChallenged {
                    note_id: topic_to_u32(&log.topics[1])?,
                    nullifier: word_to_felt(&data_words[0]),
                    restored_root,
                },
                Some(restored_root),
            )))
        }
        topic
            if topic
                == event_topic("EscapeWithdrawalFinalized(uint32,uint256,uint128,address)") =>
        {
            if log.topics.len() < 2 || data_words.len() != 3 {
                return Err(anyhow!("malformed EscapeWithdrawalFinalized log"));
            }
            Ok(Some((
                VaultEvent::EscapeWithdrawalFinalized {
                    note_id: topic_to_u32(&log.topics[1])?,
                    nullifier: word_to_felt(&data_words[0]),
                    final_balance: word_to_u128(&data_words[1]),
                },
                None,
            )))
        }
        topic if topic == event_topic("ExpiredClaimed(uint32,uint128,uint256)") => {
            if log.topics.len() < 2 || data_words.len() != 2 {
                return Err(anyhow!("malformed ExpiredClaimed log"));
            }
            let new_root = word_to_felt(&data_words[1]);
            Ok(Some((
                VaultEvent::ExpiredClaimed {
                    note_id: topic_to_u32(&log.topics[1])?,
                    deposit_amount: word_to_u128(&data_words[0]),
                    new_root,
                },
                Some(new_root),
            )))
        }
        _ => Ok(None),
    }
}

fn event_topic(signature: &str) -> String {
    let digest = Keccak256::digest(signature.as_bytes());
    format!("0x{}", hex::encode(digest))
}

fn split_words(data: &str) -> anyhow::Result<Vec<[u8; 32]>> {
    let raw = data
        .trim()
        .strip_prefix("0x")
        .or_else(|| data.trim().strip_prefix("0X"))
        .unwrap_or(data.trim());
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    if !raw.len().is_multiple_of(64) {
        return Err(anyhow!("log data is not a whole number of 32-byte words"));
    }
    let mut words = Vec::with_capacity(raw.len() / 64);
    for chunk in raw.as_bytes().chunks(64) {
        let decoded = hex::decode(chunk).context("invalid hex in log data")?;
        let mut word = [0u8; 32];
        word.copy_from_slice(&decoded);
        words.push(word);
    }
    Ok(words)
}

fn parse_hex_u64(value: &str) -> anyhow::Result<u64> {
    let raw = value
        .trim()
        .strip_prefix("0x")
        .or_else(|| value.trim().strip_prefix("0X"))
        .unwrap_or(value.trim());
    u64::from_str_radix(raw, 16).with_context(|| format!("invalid hex u64 {value}"))
}

fn topic_to_u32(topic: &str) -> anyhow::Result<u32> {
    let felt =
        Felt252::from_hex(topic).map_err(|err| anyhow!("invalid indexed topic {topic}: {err}"))?;
    let value = felt
        .to_u64()
        .ok_or_else(|| anyhow!("indexed note id does not fit in u64"))?;
    u32::try_from(value).context("indexed note id does not fit in u32")
}

fn topic_to_felt(topic: &str) -> anyhow::Result<Felt252> {
    Felt252::from_hex(topic).map_err(|err| anyhow!("invalid topic felt {topic}: {err}"))
}

fn word_to_u64(word: &[u8; 32]) -> u64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&word[24..]);
    u64::from_be_bytes(buf)
}

fn word_to_u128(word: &[u8; 32]) -> u128 {
    let mut buf = [0u8; 16];
    buf.copy_from_slice(&word[16..]);
    u128::from_be_bytes(buf)
}

fn word_to_felt(word: &[u8; 32]) -> Felt252 {
    Felt252(*word)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_word(value: Felt252) -> String {
        format!("{:0>64}", value.to_hex().trim_start_matches("0x"))
    }

    fn encode_u128(value: u128) -> String {
        format!("{value:064x}")
    }

    fn encode_u64(value: u64) -> String {
        format!("{value:064x}")
    }

    #[test]
    fn test_normalize_address_left_pads_short_values() {
        assert_eq!(
            normalize_address("0xabc").unwrap(),
            "0x0000000000000000000000000000000000000abc"
        );
    }

    #[test]
    fn test_decode_note_deposited_log() {
        let new_root = Felt252::from_u64(999);
        let log = RpcLog {
            block_number: "0x1".to_string(),
            topics: vec![
                event_topic("NoteDeposited(uint32,bytes32,uint128,uint64,uint256)"),
                Felt252::from_u64(7).to_hex(),
                Felt252::from_u64(1234).to_hex(),
            ],
            data: format!(
                "0x{}{}{}",
                encode_u128(55),
                encode_u64(1_700_000_000),
                encode_word(new_root),
            ),
        };

        let (event, expected_root) = decode_log(&log).unwrap().unwrap();
        match event {
            VaultEvent::NoteDeposited {
                note_id,
                commitment,
                amount,
                expiry_ts,
                new_root: event_root,
            } => {
                assert_eq!(note_id, 7);
                assert_eq!(commitment, Felt252::from_u64(1234));
                assert_eq!(amount, 55);
                assert_eq!(expiry_ts, 1_700_000_000);
                assert_eq!(event_root, new_root);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert_eq!(expected_root, Some(new_root));
    }

    #[test]
    fn test_cursor_file_round_trip() {
        let dir = std::env::temp_dir().join("zkapi_indexer_cursor");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cursor.txt");
        fs::write(&path, "17").unwrap();
        assert_eq!(load_cursor(&path).unwrap(), Some(17));
    }
}
