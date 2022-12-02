import { ConfirmedTransactionMeta, Signer, Transaction } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { connection, ctx } from '../global.js'
import { sendAndConfirmTransaction, TransactionErrorResponse } from '../solana/sendTransaction.js'
import { retryOnThrow } from './retryOnThrow.js'

export const sendTxAndRetryOnFail = async (
	tx: Transaction,
	signers?: Signer[],
): Promise<ConfirmedTransactionMeta> => {
	const { lastValidBlockHeight, blockhash } = await retryOnThrow(() =>
		connection.getLatestBlockhash('confirmed'),
	)
	tx.recentBlockhash = blockhash
	tx.lastValidBlockHeight = lastValidBlockHeight
	tx.feePayer = ctx.wallet.publicKey

	if (signers) {
		tx.partialSign(...signers)
	}
	ctx.wallet.signTransaction(tx)

	while (true) {
		const res = await sendAndConfirmTransaction(tx)
		if (res.success) {
			return res.data
		}
		if (!res.success && res.err === TransactionErrorResponse.BLOCK_HEIGHT_EXCEEDED) {
			return sendTxAndRetryOnFail(tx, signers)
		}
		await setTimeout(500)
	}
}
