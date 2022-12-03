import {
	ORCA_WHIRLPOOL_PROGRAM_ID,
	swapQuoteByInputToken,
	Whirlpool,
} from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'
import { BN } from 'bn.js'

import { RANGE_SPACING_BPS, SLIPPAGE_TOLERANCE, USDC_MINT } from '../constants.js'
import { fetcher } from '../global.js'

const getDecimals = (inputMint: string, whirlpool: Whirlpool) => {
	const tokenAInfo = whirlpool.getTokenAInfo()
	const tokenBInfo = whirlpool.getTokenBInfo()
	switch (inputMint) {
		case tokenAInfo.mint.toString(): {
			return [tokenAInfo.decimals, tokenBInfo.decimals]
		}
		case tokenBInfo.mint.toString(): {
			return [tokenBInfo.decimals, tokenAInfo.decimals]
		}
		default: {
			throw Error(`Pool does not include input mint: ${inputMint}`)
		}
	}
}

type GetQuoteParams = {
	whirlpool: Whirlpool
	inputMint: PublicKey
	inputAmountUi: number
	refresh?: boolean
}

const getQuote = async ({
	whirlpool,
	inputMint,
	inputAmountUi,
	refresh = true,
}: GetQuoteParams) => {
	const inputMintStr = inputMint.toString()
	const [inputDecimals, outputDecimals] = getDecimals(inputMintStr, whirlpool)

	const inputAmount = new BN(inputAmountUi * 10 ** inputDecimals)
	const res = await swapQuoteByInputToken(
		whirlpool,
		inputMint,
		inputAmount,
		SLIPPAGE_TOLERANCE,
		ORCA_WHIRLPOOL_PROGRAM_ID,
		fetcher,
		refresh,
	)

	const outAmountUi = res.estimatedAmountOut.toNumber() / 10 ** outputDecimals
	const price = inputAmountUi / outAmountUi

	const usdcMintStr = USDC_MINT.toString()
	if (inputMintStr !== usdcMintStr && whirlpool.getTokenBInfo().mint.toString() === usdcMintStr) {
		const usdcPrice = 1 / price
		return {
			inputAmountUi,
			outAmountUi,
			price: usdcPrice,
		}
	}

	return {
		inputAmountUi,
		outAmountUi,
		price,
	}
}

export const getAvgPriceWithBoundaries = async (whirlpool: Whirlpool) => {
	const tokenA = whirlpool.getTokenAInfo()
	const aToBQuote = await getQuote({
		whirlpool,
		inputMint: tokenA.mint,
		inputAmountUi: 1,
	})

	const tokenB = whirlpool.getTokenBInfo()
	const bToAQuote = await getQuote({
		whirlpool,
		inputMint: tokenB.mint,
		inputAmountUi: aToBQuote.outAmountUi,
		refresh: false,
	})

	const avgPrice = Math.round(((aToBQuote.price + bToAQuote.price) / 2) * 10 ** 6) / 10 ** 6

	const lowerBoundary = aToBQuote.price * (1 - RANGE_SPACING_BPS)
	const higherBoundary = bToAQuote.price * (1 + RANGE_SPACING_BPS)

	return {
		price: avgPrice,
		lowerBoundary,
		higherBoundary,
	}
}
