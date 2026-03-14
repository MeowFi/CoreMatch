use anchor_lang::prelude::*;

#[error_code]
pub enum CoreMatchError {
    #[msg("The bid price is lower than the ask price.")]
    PriceNotCrossed,
    #[msg("This order has already been 100% filled.")]
    OrderAlreadyFilled,
    #[msg("A mathematical overflow occurred.")]
    MathOverflow,
    #[msg("Invalid order sides: one must be a bid and the other an ask.")]
    InvalidOrderSide,
    #[msg("Orders must belong to the same market.")]
    MarketMismatch,
    #[msg("Settlement token accounts do not match the expected maker and mint.")]
    InvalidSettlementAccount,
}
