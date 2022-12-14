import { IncreaseLiquidityInput } from '@orca-so/whirlpools-sdk'
import { createCloseAccountInstruction } from '@solana/spl-token'
import { createSyncNativeInstruction } from '@solana/spl-token'
import { createAssociatedTokenAccountInstruction } from '@solana/spl-token'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

import { SOL_MINT } from '../constants.js'
import { connection, ctx, tokenA, tokenB } from '../global.js'
import { retryOnThrow } from './retryOnThrow.js'

export type TokenData = {
	mint: PublicKey
	ATAddress: PublicKey
}

export const buildCreateAndCloseATAccountsInstructions = async (tokensData: TokenData[]) => {
	const ATAccounts = await retryOnThrow(() =>
		connection.getMultipleAccountsInfo(tokensData.map(({ ATAddress }) => ATAddress)),
	)

	const setupInstructions: TransactionInstruction[] = []
	const cleanupInstructions: TransactionInstruction[] = []

	tokensData.forEach(({ mint, ATAddress }, i) => {
		const currentATAccount = ATAccounts[i]

		if (currentATAccount?.data) {
			return
		}

		setupInstructions.push(
			createAssociatedTokenAccountInstruction(
				ctx.wallet.publicKey,
				ATAddress,
				ctx.wallet.publicKey,
				mint,
			),
		)

		if (mint.equals(SOL_MINT)) {
			cleanupInstructions.push(
				createCloseAccountInstruction(ATAddress, ctx.wallet.publicKey, ctx.wallet.publicKey),
			)
		}
	})

	return {
		setupInstructions,
		cleanupInstructions,
	}
}

export const buildWrapSolInstruction = (liqInput: IncreaseLiquidityInput) => {
	const instructions: TransactionInstruction[] = []
	const amounts: number[] = [liqInput.tokenMaxA.toNumber(), liqInput.tokenMaxB.toNumber()]
	;[tokenA, tokenB].forEach(({ mint, ATAddress }, i) => {
		if (mint.equals(SOL_MINT)) {
			instructions.push(
				SystemProgram.transfer({
					fromPubkey: ctx.wallet.publicKey,
					toPubkey: ATAddress,
					lamports: amounts[i],
				}),
				createSyncNativeInstruction(ATAddress),
			)
		}
	})
	return instructions
}
