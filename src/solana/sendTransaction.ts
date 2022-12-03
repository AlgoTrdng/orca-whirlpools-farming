import { ConfirmedTransactionMeta, Transaction } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { connection } from '../global.js'

const MAX_CONFIRMATION_TIME = 120_000

export enum TransactionErrorResponse {
	BLOCK_HEIGHT_EXCEEDED = 'blockHeightExceeded',
	GENERIC_ERROR = 'genericError',
	SLIPPAGE_EXCEEDED = 'slippageExceeded',
	/** Max redemption time is exceeded */
	TIMEOUT = 'transactionTimedOut',
}

type JupiterInstructionError = [number, { Custom: number }]

type JupiterTxError = {
	InstructionError?: JupiterInstructionError
}

const watchTxConfirmation = async (startTime: number, txId: string, abortSignal: AbortSignal) => {
	while (new Date().getTime() - startTime < MAX_CONFIRMATION_TIME && !abortSignal.aborted) {
		const response = await Promise.any([
			// TODO: Try to fix error
			// StructError: Expected the value to satisfy a union of `type | type`, but received: [object Object]
			connection.getTransaction(txId, {
				commitment: 'confirmed',
				maxSupportedTransactionVersion: 0,
			}),
			setTimeout(5000),
		])
		console.log('TxResponse', response)
		if (response?.meta) {
			if (response.meta.err) {
				const jupTxError = response.meta.err as JupiterTxError
				if (jupTxError.InstructionError && jupTxError.InstructionError[1].Custom === 6000) {
					return TransactionErrorResponse.SLIPPAGE_EXCEEDED
				}
				console.log('TX_ERROR', response.meta.err)
				return TransactionErrorResponse.GENERIC_ERROR
			}

			return response.meta
		}
		await setTimeout(1000)
	}

	return TransactionErrorResponse.TIMEOUT
}

const watchBlockHeight = async (
	startTime: number,
	transaction: Transaction,
	abortSignal: AbortSignal,
) => {
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const txValidUntilBlockHeight = transaction.lastValidBlockHeight!

	while (new Date().getTime() - startTime < MAX_CONFIRMATION_TIME && !abortSignal.aborted) {
		let blockHeight = -1
		try {
			blockHeight = await connection.getBlockHeight(connection.commitment)
		} catch (err) {}

		if (blockHeight > txValidUntilBlockHeight) {
			return TransactionErrorResponse.BLOCK_HEIGHT_EXCEEDED
		}

		await setTimeout(2000)
	}

	return TransactionErrorResponse.TIMEOUT
}

export type SuccessResponse = {
	success: true
	data: ConfirmedTransactionMeta
}

export type ErrorResponse = {
	success: false
	err: TransactionErrorResponse
}

export const sendAndConfirmTransaction = async (
	transaction: Transaction,
): Promise<SuccessResponse | ErrorResponse> => {
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

	if (typeof response === 'string') {
		return {
			success: false,
			err: response,
		}
	}

	return {
		success: true,
		data: response,
	}
}
