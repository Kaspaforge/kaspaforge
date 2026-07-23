//! dealctl as a library — the party-side recovery modules, exposed so integration tests (e.g. the
//! simnet E2E) can drive the real node/txbuild/envelope code paths. The `dealctl` binary is a thin
//! wrapper over these modules.

pub mod commands;
pub mod envelope;
pub mod extract;
pub mod node;
pub mod preview;
pub mod txbuild;
