use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::CoreMatchError;
use crate::state::{Market, Order};

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(
        seeds = [b"market", market.admin.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = maker,
        space = 8 + Order::INIT_SPACE,
        seeds = [
            b"order",
            market.key().as_ref(),
            maker.key().as_ref(),
            order_id.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub order: Account<'info, Order>,

    /// The maker's token account to transfer FROM
    #[account(
        mut,
        constraint = maker_token_account.owner == maker.key(),
    )]
    pub maker_token_account: Account<'info, TokenAccount>,

    /// The vault to transfer INTO (base_vault for asks, quote_vault for bids)
    #[account(
        mut,
        constraint = vault.key() == market.base_vault || vault.key() == market.quote_vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<PlaceOrder>,
    order_id: u64,
    is_bid: bool,
    price: u64,
    base_amount: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;

    // Validate the correct vault is being used
    if is_bid {
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

    // Calculate transfer amount
    let transfer_amount = if is_bid {
        // Buying base with quote: escrow quote_amount = base_amount * price
        base_amount
            .checked_mul(price)
            .ok_or(CoreMatchError::MathOverflow)?
    } else {
        // Selling base for quote: escrow base_amount directly
        base_amount
    };

    // Transfer tokens from maker to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.maker_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.maker.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, transfer_amount)?;

    // Initialize the order PDA
    let order = &mut ctx.accounts.order;
    order.maker = ctx.accounts.maker.key();
    order.market = market.key();
    order.order_id = order_id;
    order.is_bid = is_bid;
    order.price = price;
    order.base_amount = base_amount;
    order.filled_base_amount = 0;
    order.bump = ctx.bumps.order;

    msg!(
        "Order placed: id={}, is_bid={}, price={}, base_amount={}",
        order_id,
        is_bid,
        price,
        base_amount
    );

    Ok(())
}
