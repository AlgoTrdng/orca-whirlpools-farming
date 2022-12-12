import { PublicKey, Transaction } from '@solana/web3.js'
import fetch from 'node-fetch'
import { setTimeout } from 'node:timers/promises'

import { ctx } from '../global.js'
import {
	sendAndConfirmTransaction,
	TransactionResponseStatus,
	TxErrorResponse,
	TxUnconfirmedResponse,
} from '../solana/sendTransaction.js'
import { addBlockHashAndSign } from './sendTxAndRetryOnFail.js'

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v3/quote?slippageBps=10'
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v3/swap'

type Fee = {
	amount: string
	mint: string
	pct: number
}

type MarketInfo = {
	id: string
	label: string
	inputMint: string
	outputMint: string
	notEnoughLiquidity: boolean
	inAmount: string
	outAmount: string
	priceImpactPct: number
	lpFee: Fee
	platformFee: Fee
}

type Data = {
	inAmount: string
	outAmount: string
	priceImpactPct: number
	marketInfos: MarketInfo[]
	amount: string
	slippageBps: number
	otherAmountThreshold: string
	swapMode: string
}

type JupiterQuoteResponse = {
	data: Data[]
	timeTaken: number
	contextSlot: number
}

type JupiterSwapResponse = {
	setupTransaction?: string
	swapTransaction: string
	cleanupTransaction?: string
}

type SwapMode = 'ExactIn' | 'ExactOut'

export type ExecuteJupiterSwapParams = {
	inputMint: PublicKey
	outputMint: PublicKey
	amountRaw: number
	swapMode: SwapMode
}

type JupiterTransactions = {
	setup?: Transaction
	swap: Transaction
	cleanup?: Transaction
}

const fetchJupiterTransactions = async ({
	inputMint,
	outputMint,
	amountRaw,
	swapMode,
}: ExecuteJupiterSwapParams): Promise<JupiterTransactions> => {
	const urlParams = new URLSearchParams({
		inputMint: inputMint.toString(),
		outputMint: outputMint.toString(),
		amount: amountRaw.toString(),
		swapMode,
	})
	try {
		const { data: routesInfos } = (await (
			await fetch(`${JUPITER_QUOTE_API}&${urlParams.toString()}`)
		).json()) as JupiterQuoteResponse
		const res = (await (
			await fetch(JUPITER_SWAP_API, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					route: routesInfos[0],
					userPublicKey: ctx.wallet.publicKey.toString(),
				}),
			})
		).json()) as JupiterSwapResponse

		console.log(res)
		const txs: [string, Transaction][] = [
			['swap', Transaction.from(Buffer.from(res.swapTransaction, 'base64'))],
		]
		if (res.setupTransaction) {
			txs.push(['setup', Transaction.from(Buffer.from(res.setupTransaction, 'base64'))])
		}
		if (res.cleanupTransaction) {
			txs.push(['cleanup', Transaction.from(Buffer.from(res.cleanupTransaction, 'base64'))])
		}

		for (let i = 0; i < txs.length; i++) {
			const current = txs[i]
			await addBlockHashAndSign(current[1])
		}

		return Object.fromEntries(txs) as JupiterTransactions
	} catch (error) {
		console.log('FETCH JUPITER TX ERROR', error)
		await setTimeout(500)
		return fetchJupiterTransactions({ inputMint, outputMint, amountRaw, swapMode })
	}
}

export const executeJupiterSwap = async ({
	inputMint,
	outputMint,
	amountRaw,
	swapMode,
}: ExecuteJupiterSwapParams) => {
	const _fetchTxs = async () =>
		fetchJupiterTransactions({ inputMint, outputMint, amountRaw, swapMode })

	let txs = await _fetchTxs()

	const execute = async (tx: Transaction) => {
		const res = await sendAndConfirmTransaction(tx)
		if (res.status === TransactionResponseStatus.SUCCESS) {
			return res.data
		}
		throw res
	}

	while (true) {
		try {
			if (txs.setup) {
				await execute(txs.setup)
			}

			await execute(txs.swap)

			if (txs.cleanup) {
				await execute(txs.cleanup)
			}

			return
		} catch (err) {
			console.log('JUPITER ERROR', err)
			const txError = err as TxErrorResponse | TxUnconfirmedResponse

			if (txError.status === TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED) {
				txs = await _fetchTxs()
				continue
			}

			const jupError = txError.error
			if (
				jupError &&
				typeof jupError !== 'string' &&
				'InstructionError' in jupError &&
				jupError?.InstructionError &&
				jupError.InstructionError[1]
			) {
				// Slippage exceeded
				if (jupError.InstructionError[1].Custom === 6000) {
					txs = await _fetchTxs()
					continue
				}
			}

			await setTimeout(500)
		}
	}
}
