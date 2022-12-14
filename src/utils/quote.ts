import {
	ORCA_WHIRLPOOL_PROGRAM_ID,
	ParsableTickArray,
	swapQuoteWithParams,
	SwapUtils,
	TickArray,
	WhirlpoolData,
} from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'

import { WHIRLPOOL_ADDRESS } from '../config.js'
import { SLIPPAGE_TOLERANCE } from '../constants.js'
import { connection, lowerBoundaryBps, tokenA, tokenB, upperBoundaryBps } from '../global.js'
import { retryOnThrow } from './retryOnThrow.js'

const getTickArrayAccounts = async (whirlpool: WhirlpoolData) => {
	// A to B = true
	const aToBAccounts = SwapUtils.getTickArrayPublicKeys(
		whirlpool.tickCurrentIndex,
		whirlpool.tickSpacing,
		true,
		ORCA_WHIRLPOOL_PROGRAM_ID,
		WHIRLPOOL_ADDRESS,
	)
	// B to A = false
	const bToAAccounts = SwapUtils.getTickArrayPublicKeys(
		whirlpool.tickCurrentIndex,
		whirlpool.tickSpacing,
		false,
		ORCA_WHIRLPOOL_PROGRAM_ID,
		WHIRLPOOL_ADDRESS,
	)

	// Filter duplicates so we fetch each account only once
	const allAccountsAddresses = [
		...new Set([
			...aToBAccounts.map((pk) => pk.toString()),
			...bToAAccounts.map((pk) => pk.toString()),
		]),
	]
	const allAccounts = await retryOnThrow(() =>
		connection.getMultipleAccountsInfo(allAccountsAddresses.map((addr) => new PublicKey(addr))),
	)

	const tickArrayAccountsInfos: Record<'aToB' | 'bToA', TickArray[]> = {
		aToB: [],
		bToA: [],
	}

	allAccountsAddresses.forEach((accountAddr, i) => {
		const currentAccountInfo = ParsableTickArray.parse(allAccounts[i]?.data)
		if (!currentAccountInfo) {
			throw Error(`Invalid account for TickArray: ${accountAddr}`)
		}
		const existsInAToB = aToBAccounts.findIndex((pk) => pk.toString() === accountAddr)
		if (existsInAToB > -1) {
			tickArrayAccountsInfos.aToB.push({
				address: new PublicKey(accountAddr),
				data: currentAccountInfo,
			})
		}
		const existsInBToA = bToAAccounts.findIndex((pk) => pk.toString() === accountAddr)
		if (existsInBToA > -1) {
			tickArrayAccountsInfos.bToA.push({
				address: new PublicKey(accountAddr),
				data: currentAccountInfo,
			})
		}
	})

	return tickArrayAccountsInfos
}

const A_TO_B_INPUT_AMOUNT_BN = new BN(1 * 10 ** tokenA.decimals)
const B_TO_A_INPUT_AMOUNT_BN = new BN(1 * 10 ** tokenB.decimals)

type GetQuoteParams = {
	whirlpoolData: WhirlpoolData
	tickArrays: TickArray[]
	aToB: boolean
}

const getQuote = ({ whirlpoolData, tickArrays, aToB }: GetQuoteParams) => {
	// A to B (SOL to USDC) = true
	// B to A (USDC to SOL) = false
	const { estimatedAmountOut } = swapQuoteWithParams(
		{
			tokenAmount: aToB ? A_TO_B_INPUT_AMOUNT_BN : B_TO_A_INPUT_AMOUNT_BN,
			amountSpecifiedIsInput: true,
			sqrtPriceLimit: SwapUtils.getDefaultSqrtPriceLimit(aToB),
			otherAmountThreshold: SwapUtils.getDefaultOtherAmountThreshold(true),
			whirlpoolData,
			aToB,
			tickArrays,
		},
		SLIPPAGE_TOLERANCE,
	)

	if (aToB) {
		return estimatedAmountOut.toNumber() / 10 ** tokenB.decimals
	}

	const outAmountUi = estimatedAmountOut.toNumber() / 10 ** tokenA.decimals
	const price = 1 / outAmountUi
	return price
}

const round = (amount: number, decimals: number) =>
	Math.round(amount * 10 ** decimals) / 10 ** decimals

/**
 * Get avg price for 1 unit A to B swap and 1 unit B to A swap
 */
export const getQuoteInTokenBWithBoundaries = async (whirlpoolData: WhirlpoolData) => {
	const tickArrayAccounts = await getTickArrayAccounts(whirlpoolData)

	// A to B = true
	const aToBPrice = getQuote({
		whirlpoolData,
		tickArrays: tickArrayAccounts.aToB,
		aToB: true,
	})
	// B to A = false
	const bToAPrice = getQuote({
		whirlpoolData,
		tickArrays: tickArrayAccounts.bToA,
		aToB: false,
	})

	const avgPrice = round((aToBPrice + bToAPrice) / 2, tokenB.decimals)

	const lowerBoundary = round(aToBPrice * (1 - lowerBoundaryBps), tokenB.decimals)
	const higherBoundary = round(bToAPrice * (1 + upperBoundaryBps), tokenB.decimals)

	return {
		price: avgPrice,
		lowerBoundary,
		higherBoundary,
	}
}
