use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::CoreMatchError;
use crate::state::{Market, Order};

#[derive(Accounts)]
pub struct MatchOrders<'info> {
    /// Anyone can call this (permissionless cranker)
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [b"market", market.admin.key().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// The bid order (is_bid = true)
    #[account(
        mut,
        has_one = market,
        seeds = [
            b"order",
            market.key().as_ref(),
            bid_order.maker.as_ref(),
            bid_order.order_id.to_le_bytes().as_ref(),
        ],
        bump = bid_order.bump,
    )]
    pub bid_order: Box<Account<'info, Order>>,

    /// The ask order (is_bid = false)
    #[account(
        mut,
        has_one = market,
        seeds = [
            b"order",
            market.key().as_ref(),
            ask_order.maker.as_ref(),
            ask_order.order_id.to_le_bytes().as_ref(),
        ],
        bump = ask_order.bump,
    )]
    pub ask_order: Box<Account<'info, Order>>,

    /// Base vault (holds seller's escrowed base tokens)
    #[account(
        mut,
        constraint = base_vault.key() == market.base_vault,
    )]
    pub base_vault: Box<Account<'info, TokenAccount>>,

    /// Quote vault (holds buyer's escrowed quote tokens)
    #[account(
        mut,
        constraint = quote_vault.key() == market.quote_vault,
    )]
    pub quote_vault: Box<Account<'info, TokenAccount>>,

    /// Buyer's base token account (to receive base tokens)
    #[account(mut)]
    pub buyer_base_account: Box<Account<'info, TokenAccount>>,

    /// Seller's quote token account (to receive quote tokens)
    #[account(mut)]
    pub seller_quote_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: The bid maker's account for potential rent refund (validated in handler)
    #[account(mut)]
    pub bid_maker: AccountInfo<'info>,

    /// CHECK: The ask maker's account for potential rent refund (validated in handler)
    #[account(mut)]
    pub ask_maker: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MatchOrders>) -> Result<()> {
    let bid_order = &ctx.accounts.bid_order;
    let ask_order = &ctx.accounts.ask_order;

    // Validate order sides
    require!(bid_order.is_bid, CoreMatchError::InvalidOrderSide);
    require!(!ask_order.is_bid, CoreMatchError::InvalidOrderSide);

    // Validate price crossing: bid price must be >= ask price
    require!(
        bid_order.price >= ask_order.price,
        CoreMatchError::PriceNotCrossed
    );

    // Validate orders are not already fully filled
    let bid_remaining = bid_order
        .base_amount
        .checked_sub(bid_order.filled_base_amount)
        .ok_or(CoreMatchError::MathOverflow)?;
    let ask_remaining = ask_order
        .base_amount
        .checked_sub(ask_order.filled_base_amount)
        .ok_or(CoreMatchError::MathOverflow)?;

    require!(bid_remaining > 0, CoreMatchError::OrderAlreadyFilled);
    require!(ask_remaining > 0, CoreMatchError::OrderAlreadyFilled);

    // Validate maker accounts match
    require!(
        ctx.accounts.bid_maker.key() == bid_order.maker,
        CoreMatchError::InvalidOrderSide
    );
    require!(
        ctx.accounts.ask_maker.key() == ask_order.maker,
        CoreMatchError::InvalidOrderSide
    );

    // Calculate fill amount (minimum of both remaining amounts)
    let fill_amount = bid_remaining.min(ask_remaining);

    // Execute at the bid price (taker-favorable)
    let execution_price = bid_order.price;
    let quote_transfer_amount = fill_amount
        .checked_mul(execution_price)
        .ok_or(CoreMatchError::MathOverflow)?;

    // Market PDA signer seeds
    let admin_key = ctx.accounts.market.admin.key();
    let seeds = &[b"market" as &[u8], admin_key.as_ref(), &[ctx.accounts.market.bump]];
    let signer_seeds = &[&seeds[..]];

    // Transfer base tokens from base_vault to buyer
    let transfer_base = Transfer {
        from: ctx.accounts.base_vault.to_account_info(),
        to: ctx.accounts.buyer_base_account.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_base,
            signer_seeds,
        ),
        fill_amount,
    )?;

    // Transfer quote tokens from quote_vault to seller
    let transfer_quote = Transfer {
        from: ctx.accounts.quote_vault.to_account_info(),
        to: ctx.accounts.seller_quote_account.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_quote,
            signer_seeds,
        ),
        quote_transfer_amount,
    )?;

    // Update filled amounts
    let bid_order = &mut ctx.accounts.bid_order;
    bid_order.filled_base_amount = bid_order
        .filled_base_amount
        .checked_add(fill_amount)
        .ok_or(CoreMatchError::MathOverflow)?;

    let ask_order = &mut ctx.accounts.ask_order;
    ask_order.filled_base_amount = ask_order
        .filled_base_amount
        .checked_add(fill_amount)
        .ok_or(CoreMatchError::MathOverflow)?;

    msg!(
        "Orders matched: fill_amount={}, execution_price={}, quote_transferred={}",
        fill_amount,
        execution_price,
        quote_transfer_amount
    );

    // Close fully filled orders and refund rent to their respective makers
    let bid_fully_filled = bid_order.base_amount == bid_order.filled_base_amount;
    let ask_fully_filled = ask_order.base_amount == ask_order.filled_base_amount;

    if bid_fully_filled {
        let bid_order_info = bid_order.to_account_info();
        let bid_maker_info = ctx.accounts.bid_maker.to_account_info();
        close_order_account(bid_order_info, bid_maker_info)?;
    }

    if ask_fully_filled {
        let ask_order_info = ask_order.to_account_info();
        let ask_maker_info = ctx.accounts.ask_maker.to_account_info();
        close_order_account(ask_order_info, ask_maker_info)?;
    }

    Ok(())
}

/// Manually close an order account and refund rent to the maker
fn close_order_account<'info>(
    order_info: AccountInfo<'info>,
    maker_info: AccountInfo<'info>,
) -> Result<()> {
    let dest_starting_lamports = maker_info.lamports();
    **maker_info.lamports.borrow_mut() = dest_starting_lamports
        .checked_add(order_info.lamports())
        .ok_or(CoreMatchError::MathOverflow)?;
    **order_info.lamports.borrow_mut() = 0;

    // Zero out the data and assign to system program
    let mut data = order_info.try_borrow_mut_data()?;
    for byte in data.iter_mut() {
        *byte = 0;
    }

    Ok(())
}
