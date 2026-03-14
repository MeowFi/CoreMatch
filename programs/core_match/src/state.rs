use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Authority that initialized this market
    pub admin: Pubkey,
    /// Base token mint (the asset being traded)
    pub base_mint: Pubkey,
    /// Quote token mint (e.g. USDC, the currency)
    pub quote_mint: Pubkey,
    /// Program-owned token account holding escrowed base tokens
    pub base_vault: Pubkey,
    /// Program-owned token account holding escrowed quote tokens
    pub quote_vault: Pubkey,
    /// PDA bump seed
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    /// The user who placed this order
    pub maker: Pubkey,
    /// The market this order belongs to
    pub market: Pubkey,
    /// Unique order ID per maker (allows multiple orders per user)
    pub order_id: u64,
    /// true = bid (buying base with quote), false = ask (selling base for quote)
    pub is_bid: bool,
    /// Price in quote tokens per base token (scaled to token decimals)
    pub price: u64,
    /// Total base token amount for this order
    pub base_amount: u64,
    /// Amount of base tokens already filled
    pub filled_base_amount: u64,
    /// PDA bump seed
    pub bump: u8,
}
