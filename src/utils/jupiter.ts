import { PublicKey, Transaction } from '@solana/web3.js'
import fetch from 'node-fetch'
import { setTimeout } from 'node:timers/promises'

import { ctx } from '../global.js'
import { parsePostTransactionBalances } from '../solana/parseTransaction.js'
import { sendAndConfirmTransaction, TransactionErrorResponse } from '../solana/sendTransaction.js'

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

const fetchJupiterTransactions = async ({
	inputMint,
	outputMint,
	amountRaw,
	swapMode,
}: ExecuteJupiterSwapParams) => {
	const urlParams = new URLSearchParams({
		inputMint: inputMint.toString(),
		outputMint: outputMint.toString(),
		amount: amountRaw.toString(),
		swapMode,
	})
	// Handle errors
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

	const txs: [string, Transaction][] = [
		['swap', Transaction.from(Buffer.from(res.swapTransaction, 'base64'))],
	]
	if (res.setupTransaction) {
		txs.push(['setup', Transaction.from(Buffer.from(res.setupTransaction, 'base64'))])
	}
	if (res.cleanupTransaction) {
		txs.push(['cleanup', Transaction.from(Buffer.from(res.cleanupTransaction, 'base64'))])
	}

	txs.forEach((tx) => {
		ctx.wallet.signTransaction(tx[1])
	})

	return {
		...Object.fromEntries(txs),
	} as {
		setup?: Transaction
		swap: Transaction
		cleanup?: Transaction
	}
}

export const executeJupiterSwap = async ({
	inputMint,
	outputMint,
	amountRaw,
	swapMode,
}: ExecuteJupiterSwapParams) => {
	let txs = await fetchJupiterTransactions({ inputMint, outputMint, amountRaw, swapMode })

	const execute = async (tx: Transaction) => {
		const res = await sendAndConfirmTransaction(tx)
		if (res.success) {
			return res.data
		}
		throw Error(res.err)
	}

	while (true) {
		try {
			if (txs.setup) {
				await execute(txs.setup)
			}

			const swapResponse = await execute(txs.swap)

			if (txs.cleanup) {
				await execute(txs.cleanup)
			}

			return parsePostTransactionBalances({
				meta: swapResponse,
				inputMint,
				outputMint,
			})
		} catch (error) {
			const errorMsg = (error as Error).message as TransactionErrorResponse
			console.log({ errorMsg })
			switch (errorMsg) {
				case TransactionErrorResponse.BLOCK_HEIGHT_EXCEEDED:
				case TransactionErrorResponse.SLIPPAGE_EXCEEDED: {
					txs = await fetchJupiterTransactions({ inputMint, outputMint, amountRaw, swapMode })
				}
				default: {
					await setTimeout(500)
				}
			}
		}
	}
}
