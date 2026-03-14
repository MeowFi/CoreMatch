use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::CoreMatchError;
use crate::state::{Market, Order};

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [b"market", market.admin.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        close = maker,
        has_one = maker,
        has_one = market,
        seeds = [
            b"order",
            market.key().as_ref(),
            maker.key().as_ref(),
            order.order_id.to_le_bytes().as_ref(),
        ],
        bump = order.bump,
    )]
    pub order: Account<'info, Order>,

    /// The vault holding the escrowed tokens
    #[account(
        mut,
        constraint = vault.key() == market.base_vault || vault.key() == market.quote_vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The maker's token account to refund TO
    #[account(
        mut,
        constraint = maker_token_account.owner == maker.key(),
    )]
    pub maker_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelOrder>) -> Result<()> {
    let order = &ctx.accounts.order;
    let market = &ctx.accounts.market;

    // Validate the correct vault
    if order.is_bid {
        require!(
            ctx.accounts.vault.key() == market.quote_vault,
            CoreMatchError::InvalidOrderSide
        );
    } else {
        require!(
            ctx.accounts.vault.key() == market.base_vault,
            CoreMatchError::InvalidOrderSide
        );
    }

    // Calculate remaining unfilled tokens to refund
    let remaining_base = order
        .base_amount
        .checked_sub(order.filled_base_amount)
        .ok_or(CoreMatchError::MathOverflow)?;

    require!(remaining_base > 0, CoreMatchError::OrderAlreadyFilled);

    let refund_amount = if order.is_bid {
        // Refund remaining quote tokens: remaining_base * price
        remaining_base
            .checked_mul(order.price)
            .ok_or(CoreMatchError::MathOverflow)?
    } else {
        // Refund remaining base tokens
        remaining_base
    };

    // CPI transfer from vault back to maker using Market PDA as signer
    let admin_key = market.admin.key();
    let seeds = &[b"market" as &[u8], admin_key.as_ref(), &[market.bump]];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.maker_token_account.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, refund_amount)?;

    msg!(
        "Order cancelled: id={}, refunded={} tokens",
        order.order_id,
        refund_amount
    );

    // Order PDA is closed via `close = maker` in the account constraint

    Ok(())
}
