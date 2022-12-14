import {
	ConfirmedTransactionMeta,
	Signer,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { connection, wallet } from '../global.js'
import {
	sendAndConfirmTransaction,
	TransactionResponseStatus,
	VersionedTxWithLastValidBlockHeight,
} from '../solana/sendTransaction.js'
import { retryOnThrow } from './retryOnThrow.js'

type AddBlockHashAndSignParamsLegacy = {
	tx: Transaction
	signers?: Signer[]
	version: 'legacy'
}

type AddBlockHashAndSignParamsV0 = {
	tx: VersionedTransaction
	signers?: Signer[]
	version: 0
}

export function addBlockHashAndSign(params: AddBlockHashAndSignParamsLegacy): Promise<Transaction>
export function addBlockHashAndSign(
	params: AddBlockHashAndSignParamsV0,
): Promise<VersionedTxWithLastValidBlockHeight>
export async function addBlockHashAndSign({
	tx,
	signers,
	version,
}: AddBlockHashAndSignParamsV0 | AddBlockHashAndSignParamsLegacy): Promise<
	Transaction | VersionedTxWithLastValidBlockHeight
> {
	const { lastValidBlockHeight, blockhash } = await retryOnThrow(() =>
		connection.getLatestBlockhash('confirmed'),
	)

	if (version === 'legacy') {
		tx.recentBlockhash = blockhash
		tx.lastValidBlockHeight = lastValidBlockHeight
		tx.feePayer = wallet.publicKey
		tx.partialSign(wallet, ...(signers || []))
		return tx
	}

	const _tx = tx as VersionedTxWithLastValidBlockHeight
	_tx.message.recentBlockhash = blockhash
	_tx.lastValidBlockHeight = lastValidBlockHeight
	_tx.sign([wallet, ...(signers || [])])
	return _tx
}

export const sendTxAndRetryOnFail = async (
	tx: Transaction,
	signers?: Signer[],
): Promise<ConfirmedTransactionMeta> => {
	const signed = await addBlockHashAndSign({
		tx,
		signers,
		version: 'legacy',
	})

	while (true) {
		const res = await sendAndConfirmTransaction(signed)
		if (res.status === TransactionResponseStatus.SUCCESS) {
			return res.data
		}

		if (res.status === TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED) {
			return sendTxAndRetryOnFail(tx, signers)
		}

		await setTimeout(500)
	}
}
