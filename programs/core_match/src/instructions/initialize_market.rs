use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::Market;

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", admin.key().as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// The base token mint (the asset being traded)
    pub base_mint: Account<'info, Mint>,

    /// The quote token mint (e.g. USDC)
    pub quote_mint: Account<'info, Mint>,

    /// Vault to hold escrowed base tokens, owned by Market PDA
    #[account(
        init,
        payer = admin,
        token::mint = base_mint,
        token::authority = market,
    )]
    pub base_vault: Account<'info, TokenAccount>,

    /// Vault to hold escrowed quote tokens, owned by Market PDA
    #[account(
        init,
        payer = admin,
        token::mint = quote_mint,
        token::authority = market,
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    market.admin = ctx.accounts.admin.key();
    market.base_mint = ctx.accounts.base_mint.key();
    market.quote_mint = ctx.accounts.quote_mint.key();
    market.base_vault = ctx.accounts.base_vault.key();
    market.quote_vault = ctx.accounts.quote_vault.key();
    market.bump = ctx.bumps.market;

    msg!(
        "Market initialized: base_mint={}, quote_mint={}",
        market.base_mint,
        market.quote_mint
    );

    Ok(())
}
