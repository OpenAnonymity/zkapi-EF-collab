pub mod compat;
pub mod config;
pub mod error;
pub mod indexer;
pub mod routes;
pub mod service;

pub use config::{AuthConfig, ModelDescriptor, RequestMode, DEFAULT_OPENROUTER_REQUESTS_PER_KEY};
pub use routes::{build_router, run};
pub use service::{
    AuthService, ConfirmDepositRequest, CoreRequest, CoreResponse, DemoOverview, DepositPlan,
    FundingConfig, IndexerSnapshot, NoteStatus, ProtocolResponseTrace, RecoverResult,
    RequestDemoResult, RequestPreview, RetiredNote, ServerAttestationSnapshot,
    ServerHealthSnapshot, ServerSnapshot, WalletStatus, WithdrawalMode, WithdrawalPlan,
    ZkapiConfig, CREDITS_PER_USD,
};
