import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import fetch from 'node-fetch'
import { setTimeout } from 'node:timers/promises'

import { wallet } from '../global.js'
import {
	sendAndConfirmTransaction,
	TransactionResponseStatus,
	TxErrorResponse,
	TxUnconfirmedResponse,
	VersionedTxWithLastValidBlockHeight,
} from '../solana/sendTransaction.js'
import { addBlockHashAndSign } from './sendTxAndRetryOnFail.js'

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v4/quote?slippageBps=10'
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v4/swap'

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
	swapTransaction: string
}

type SwapMode = 'ExactIn' | 'ExactOut'

export type ExecuteJupiterSwapParams = {
	inputMint: PublicKey
	outputMint: PublicKey
	amountRaw: number
	swapMode: SwapMode
}

const fetchJupiterTransaction = async ({
	inputMint,
	outputMint,
	amountRaw,
	swapMode,
}: ExecuteJupiterSwapParams): Promise<VersionedTxWithLastValidBlockHeight> => {
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
					userPublicKey: wallet.publicKey.toString(),
				}),
			})
		).json()) as JupiterSwapResponse

		const tx = VersionedTransaction.deserialize(
			Buffer.from(res.swapTransaction, 'base64'),
		) as VersionedTxWithLastValidBlockHeight

		return addBlockHashAndSign({
			version: 0,
			tx,
		})
	} catch (error) {
		console.log('FETCH JUPITER TX ERROR', error)
		await setTimeout(500)
		return fetchJupiterTransaction({ inputMint, outputMint, amountRaw, swapMode })
	}
}

export const executeJupiterSwap = async ({
	inputMint,
	outputMint,
	amountRaw,
	swapMode,
}: ExecuteJupiterSwapParams) => {
	const _fetchTxs = async () =>
		fetchJupiterTransaction({ inputMint, outputMint, amountRaw, swapMode })

	let tx = await _fetchTxs()

	while (true) {
		const res = await sendAndConfirmTransaction(tx)

		if (res.status === TransactionResponseStatus.SUCCESS) {
			return
		}

		const err = res.error
		console.log('JUPITER ERROR', err)
		const txError = err as TxErrorResponse | TxUnconfirmedResponse

		if (txError.status === TransactionResponseStatus.BLOCK_HEIGHT_EXCEEDED) {
			tx = await _fetchTxs()
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
				tx = await _fetchTxs()
				continue
			}
		}

		await setTimeout(500)
	}
}
