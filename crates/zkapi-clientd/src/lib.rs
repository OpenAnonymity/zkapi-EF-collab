pub mod compat;
pub mod config;
pub mod error;
pub mod indexer;
pub mod routes;
pub mod service;

pub use config::{AuthConfig, ModelDescriptor, RequestMode};
pub use routes::{build_router, run};
pub use service::{
    AuthService, ConfirmDepositRequest, CoreRequest, CoreResponse, DemoOverview, DepositPlan,
    DirectLeaseStatus, FundingConfig, IndexerSnapshot, NoteStatus, PreparedWithdrawalStatus,
    ProtocolResponseTrace, RecoverResult, RequestDemoResult, RequestPreview, RetiredNote,
    ServerAttestationSnapshot, ServerHealthSnapshot, ServerSnapshot, WalletStatus,
    WithdrawalChainStatus, WithdrawalMode, WithdrawalPlan, ZkapiConfig, CREDITS_PER_USD,
};
