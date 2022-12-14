import { createCloseAccountInstruction } from '@solana/spl-token'
import { createSyncNativeInstruction } from '@solana/spl-token'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { createAssociatedTokenAccountInstruction } from '@solana/spl-token'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'

import { SOL_MINT } from '../constants.js'
import { connection, ctx, wallet } from '../global.js'
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

export const buildWrapSolInstructions = (amountRaw: number) => {
	const wrappedSolATAddress = getAssociatedTokenAddressSync(SOL_MINT, wallet.publicKey)

	const main = [
		createAssociatedTokenAccountInstruction(
			wallet.publicKey,
			wrappedSolATAddress,
			wallet.publicKey,
			SOL_MINT,
		),
		SystemProgram.transfer({
			fromPubkey: ctx.wallet.publicKey,
			toPubkey: wrappedSolATAddress,
			lamports: amountRaw,
		}),
		createSyncNativeInstruction(wrappedSolATAddress),
	]
	const cleanup = createCloseAccountInstruction(
		wrappedSolATAddress,
		wallet.publicKey,
		wallet.publicKey,
	)

	return {
		main,
		cleanup,
	}
}
