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

import { RANGE_SPACING_BPS, SLIPPAGE_TOLERANCE } from '../constants.js'
import { connection } from '../global.js'
import { retryOnThrow } from './retryOnThrow.js'

const getTickArrayAccounts = async (whirlpool: WhirlpoolData, whirlpoolAddress: PublicKey) => {
	// A to B (SOL to USDC) = true
	const aToBAccounts = SwapUtils.getTickArrayPublicKeys(
		whirlpool.tickCurrentIndex,
		whirlpool.tickSpacing,
		true,
		ORCA_WHIRLPOOL_PROGRAM_ID,
		whirlpoolAddress,
	)
	// B to A (USDC to SOL) = false
	const bToAAccounts = SwapUtils.getTickArrayPublicKeys(
		whirlpool.tickCurrentIndex,
		whirlpool.tickSpacing,
		false,
		ORCA_WHIRLPOOL_PROGRAM_ID,
		whirlpoolAddress,
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

// 1 SOL
const A_TO_B_INPUT_AMOUNT_BN = new BN(1_000_000_000)
// 1 USDC
const B_TO_A_INPUT_AMOUNT_BN = new BN(1_000_000)

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
		return estimatedAmountOut.toNumber() / 10 ** 6
	}

	const outAmountUi = estimatedAmountOut.toNumber() / 10 ** 9
	const price = 1 / outAmountUi
	return price
}

type GetQuoteWithBoundariesParams = {
	whirlpoolData: WhirlpoolData
	whirlpoolAddress: PublicKey
}

/**
 * Get avg price for 1 unit A to B swap and 1 unit B to A swap
 */
export const getQuoteWithBoundaries = async ({
	whirlpoolData,
	whirlpoolAddress,
}: GetQuoteWithBoundariesParams) => {
	const tickArrayAccounts = await getTickArrayAccounts(whirlpoolData, whirlpoolAddress)

	// A to B (SOL to USDC) = true
	const aToBPrice = getQuote({
		whirlpoolData,
		tickArrays: tickArrayAccounts.aToB,
		aToB: true,
	})
	// B to A (USDC to SOL) = false
	const bToAPrice = getQuote({
		whirlpoolData,
		tickArrays: tickArrayAccounts.bToA,
		aToB: false,
	})

	const avgPrice = Math.round(((aToBPrice + bToAPrice) / 2) * 10 ** 6) / 10 ** 6

	const lowerBoundary = aToBPrice * (1 - RANGE_SPACING_BPS)
	const higherBoundary = bToAPrice * (1 + RANGE_SPACING_BPS)

	return {
		price: avgPrice,
		lowerBoundary,
		higherBoundary,
	}
}
