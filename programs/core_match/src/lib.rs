use anchor_lang::prelude::*;

declare_id!("8WbYeq7UEdUoPm7RLEkuVRGvaCvaZx4tn2aaZta8QA5X");

pub mod errors;
pub mod instructions;
pub mod state;

pub use instructions::initialize_market::*;
pub use instructions::place_order::*;
pub use instructions::cancel_order::*;
pub use instructions::match_orders::*;

#[program]
pub mod core_match {
    use super::*;

    pub fn initialize_market(ctx: Context<InitializeMarket>) -> Result<()> {
        instructions::initialize_market::handler(ctx)
    }

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        order_id: u64,
        is_bid: bool,
        price: u64,
        base_amount: u64,
    ) -> Result<()> {
        instructions::place_order::handler(ctx, order_id, is_bid, price, base_amount)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::cancel_order::handler(ctx)
    }

    pub fn match_orders(ctx: Context<MatchOrders>) -> Result<()> {
        instructions::match_orders::handler(ctx)
    }
}
