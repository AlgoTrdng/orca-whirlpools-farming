import { ConfirmedTransactionMeta, Signer, Transaction } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { connection, ctx } from '../global.js'
import { sendAndConfirmTransaction, TransactionResponseStatus } from '../solana/sendTransaction.js'
import { retryOnThrow } from './retryOnThrow.js'

export const addBlockHashAndSign = async (tx: Transaction, signers?: Signer[]) => {
	const { lastValidBlockHeight, blockhash } = await retryOnThrow(() =>
		connection.getLatestBlockhash('confirmed'),
	)
	tx.recentBlockhash = blockhash
	tx.lastValidBlockHeight = lastValidBlockHeight
	tx.feePayer = ctx.wallet.publicKey

	if (signers?.length) {
		tx.partialSign(...signers)
	}
	ctx.wallet.signTransaction(tx)
}

export const sendTxAndRetryOnFail = async (
	tx: Transaction,
	signers?: Signer[],
): Promise<ConfirmedTransactionMeta> => {
	await addBlockHashAndSign(tx, signers)

	while (true) {
		const res = await sendAndConfirmTransaction(tx)
		if (res.status === TransactionResponseStatus.SUCCESS) {
			return res.data
		}

		if (res.status === TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED) {
			return sendTxAndRetryOnFail(tx, signers)
		}

		await setTimeout(500)
	}
}
