import {
	ConfirmedTransactionMeta,
	Transaction,
	TransactionError,
	VersionedTransaction,
} from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { connection } from '../global.js'
import { getTransaction } from './getTransaction.js'

const MAX_CONFIRMATION_TIME = 120_000

export type VersionedTxWithLastValidBlockHeight = VersionedTransaction & {
	lastValidBlockHeight: number
}

type InstructionError = [number, { Custom: number }]

type TransactionInstructionError = {
	InstructionError?: InstructionError
}

export enum TransactionResponseStatus {
	/** Tx was not confirmed and can not be confirmed anymore without updating block hash and block height */
	BLOCK_HEIGHT_EXCEEDED = 'BLOCK_HEIGHT_EXCEEDED',
	/** Tx failed with some error */
	ERROR = 'ERROR',
	/** Tx was not confirmed specified time in time, can be sent again with same txId */
	TIMEOUT = 'TRANSACTION_TIMEOUT',
	SUCCESS = 'SUCCESS',
}

export type TxSuccessResponse = {
	status: TransactionResponseStatus.SUCCESS
	data: ConfirmedTransactionMeta
	error: null
}

export type TxErrorResponse = {
	status: TransactionResponseStatus.ERROR
	data: null
	error: TransactionError | TransactionInstructionError
}

export type TxUnconfirmedResponse = {
	status: TransactionResponseStatus.TIMEOUT | TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED
	data: null
	error: null
}

const watchTxConfirmation = async (
	startTime: number,
	txId: string,
	abortSignal: AbortSignal,
): Promise<TxSuccessResponse | TxErrorResponse | TxUnconfirmedResponse> => {
	while (new Date().getTime() - startTime < MAX_CONFIRMATION_TIME && !abortSignal.aborted) {
		const tx = await Promise.any([getTransaction(txId), setTimeout(5000)])

		if (tx?.meta?.err) {
			console.log('TX ERROR', tx.meta.err)
			return {
				data: null,
				error: tx.meta.err,
				status: TransactionResponseStatus.ERROR,
			}
		}

		if (tx?.meta) {
			console.log('TX META', tx.meta)
			return {
				data: tx.meta,
				error: null,
				status: TransactionResponseStatus.SUCCESS,
			}
		}

		await setTimeout(1000)
	}

	return {
		data: null,
		error: null,
		status: TransactionResponseStatus.TIMEOUT,
	}
}

const watchBlockHeight = async (
	startTime: number,
	transaction: Transaction | VersionedTxWithLastValidBlockHeight,
	abortSignal: AbortSignal,
): Promise<TxUnconfirmedResponse> => {
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const txValidUntilBlockHeight = transaction.lastValidBlockHeight!

	while (new Date().getTime() - startTime < MAX_CONFIRMATION_TIME && !abortSignal.aborted) {
		let blockHeight = -1
		try {
			blockHeight = await connection.getBlockHeight(connection.commitment)
		} catch (err) {}

		if (blockHeight > txValidUntilBlockHeight) {
			return {
				status: TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED,
				error: null,
				data: null,
			}
		}

		await setTimeout(2000)
	}

	return {
		status: TransactionResponseStatus.TIMEOUT,
		data: null,
		error: null,
	}
}

export const sendAndConfirmTransaction = async (
	transaction: Transaction | VersionedTxWithLastValidBlockHeight,
): Promise<TxSuccessResponse | TxErrorResponse | TxUnconfirmedResponse> => {
	const rawTx = transaction.serialize()
	const txId = await connection.sendRawTransaction(rawTx, {
		maxRetries: 20,
		skipPreflight: true,
	})
	console.log({ txId })
	const startTime = new Date().getTime()

	const abortController = new AbortController()
	const response = await Promise.any([
		watchTxConfirmation(startTime, txId, abortController.signal),
		watchBlockHeight(startTime, transaction, abortController.signal),
	])
	abortController.abort()

	return response
}
