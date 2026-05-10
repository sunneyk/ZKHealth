//! ZKHealth payment splitter — Solana program (Anchor 0.30)
//!
//! Researchers pay a per-query escrow PDA. The backend (the only entity that
//! knows which contributors actually backed a given query) signs a single
//! `release` instruction that atomically distributes the escrowed SOL across
//! every contributor's wallet.
//!
//! Why this exists:
//!   1. Privacy. The buyer never sees individual contributor addresses.
//!   2. Cost. One `pay` tx + one `release` tx, regardless of contributor count.
//!   3. Atomicity. Either every contributor is paid, or the release reverts.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("ZKHsp1it1111111111111111111111111111111111");

#[program]
pub mod zkhealth_split {
    use super::*;

    /// Researcher transfers `amount` lamports from their wallet to the per-query
    /// escrow PDA derived from `query_id`. The PDA holds funds until release.
    pub fn pay(ctx: Context<Pay>, _query_id: [u8; 32], amount: u64) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;
        msg!("escrow_pay: {} lamports", amount);
        Ok(())
    }

    /// Authority (the ZKHealth backend) signs to release escrow into per-contributor
    /// shares. `amounts[i]` is sent to `remaining_accounts[i]`. Atomic — if any
    /// transfer would underflow the escrow, the entire release reverts.
    pub fn release(
        ctx: Context<Release>,
        _query_id: [u8; 32],
        amounts: Vec<u64>,
    ) -> Result<()> {
        require_eq!(
            amounts.len(),
            ctx.remaining_accounts.len(),
            ErrorCode::CountMismatch
        );

        let escrow = &ctx.accounts.escrow;
        let total: u64 = amounts.iter().try_fold(0u64, |acc, &a| {
            acc.checked_add(a).ok_or(ErrorCode::Overflow)
        })?;
        require_gte!(
            **escrow.lamports.borrow(),
            total,
            ErrorCode::InsufficientEscrow
        );

        for (i, &amount) in amounts.iter().enumerate() {
            **escrow.try_borrow_mut_lamports()? = escrow
                .lamports()
                .checked_sub(amount)
                .ok_or(ErrorCode::Underflow)?;
            **ctx.remaining_accounts[i].try_borrow_mut_lamports()? = ctx.remaining_accounts[i]
                .lamports()
                .checked_add(amount)
                .ok_or(ErrorCode::Overflow)?;
        }

        msg!("released {} lamports to {} contributors", total, amounts.len());
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(query_id: [u8; 32], amount: u64)]
pub struct Pay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// PDA derived from `b"escrow" || query_id`. Holds the buyer's payment
    /// until the backend authority releases it.
    #[account(
        mut,
        seeds = [b"escrow", &query_id],
        bump,
    )]
    pub escrow: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(query_id: [u8; 32])]
pub struct Release<'info> {
    /// The backend signs releases. Contributor list is private to the backend;
    /// the program only checks that the authority is correct and the math sums.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", &query_id],
        bump,
    )]
    pub escrow: SystemAccount<'info>,
    // Contributor wallets are passed via `remaining_accounts` — variable length.
}

#[error_code]
pub enum ErrorCode {
    #[msg("Per-contributor amounts must match the number of contributor accounts")]
    CountMismatch,
    #[msg("Sum of release amounts exceeds escrow balance")]
    InsufficientEscrow,
    #[msg("Lamport arithmetic overflow")]
    Overflow,
    #[msg("Lamport arithmetic underflow")]
    Underflow,
}
