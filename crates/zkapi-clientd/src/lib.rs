pub mod compat;
pub mod config;
pub mod error;
pub mod indexer;
pub mod routes;
pub mod service;

pub use config::{AuthConfig, ModelDescriptor};
pub use routes::{build_router, run};
pub use service::{
    AuthService, ConfirmDepositRequest, CoreRequest, CoreResponse, DemoOverview, DepositPlan,
    FundingConfig, IndexerSnapshot, NoteStatus, ProtocolResponseTrace, RecoverResult,
    RequestDemoResult, RequestPreview, ServerAttestationSnapshot, ServerHealthSnapshot,
    ServerSnapshot, WalletStatus, WithdrawalMode, WithdrawalPlan,
};
