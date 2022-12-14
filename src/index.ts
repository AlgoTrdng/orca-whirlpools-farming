import { ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil } from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { USDC_MINT, SOL_MINT, MIN_SOL_AMOUNT_RAW } from './constants.js'
import { closePosition } from './orca/closePosition.js'
import { getWhirlpoolData } from './orca/pool.js'
import { openPosition } from './orca/openPosition.js'
import { state } from './state.js'
import { executeJupiterSwap } from './utils/jupiter.js'
import { getQuoteInTokenBWithBoundaries } from './utils/quote.js'
import { lowerBoundaryBps, tokenA, tokenB, upperBoundaryBps } from './global.js'

const wait = () => setTimeout(60_000)

const swapRemainingSol = async (balances: Map<PublicKey, number>) => {
	const execute = async (mint: PublicKey) => {
		const tokenBalance = balances.get(mint)

		if (!mint.equals(USDC_MINT) && tokenBalance) {
			const minAmount = mint.equals(SOL_MINT) ? MIN_SOL_AMOUNT_RAW : 0
			const overflowAmount = tokenBalance - minAmount
			if (overflowAmount > minAmount * 1.4) {
				console.log(`Swapping overflow ${mint.toString()} amount to USDC: ${overflowAmount}`)
				await executeJupiterSwap({
					inputMint: mint,
					outputMint: USDC_MINT,
					amountRaw: overflowAmount,
					swapMode: 'ExactIn',
				})
			}
		}
	}

	await execute(tokenA.mint)
	await execute(tokenB.mint)
}

// INIT
// Open position
if (!state.data?.position) {
	const whirlpoolData = await getWhirlpoolData()
	const { higherBoundary, lowerBoundary, price } = await getQuoteInTokenBWithBoundaries(
		whirlpoolData,
	)
	const { positionMint, balances } = await openPosition({
		whirlpoolData: whirlpoolData,
		upperBoundaryPrice: higherBoundary,
		lowerBoundaryPrice: lowerBoundary,
	})
	const positionPDAddress = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint)

	state.data = {
		position: {
			address: positionPDAddress.publicKey,
			openPrice: price,
		},
	}

	await swapRemainingSol(balances)

	await state.write()
	await wait()
}

// WATCH
while (true) {
	const whirlpoolData = await getWhirlpoolData()
	const { price, higherBoundary, lowerBoundary } = await getQuoteInTokenBWithBoundaries(
		whirlpoolData,
	)

	const position = state.data.position!

	console.log(
		`\nCurrent price: ${price}\n` +
			`Position: \n` +
			` Open price: ${position.openPrice}\n` +
			` Current position price deviation: ${(price / position.openPrice - 1) * 100}`,
	)

	// Check if current is in bounds
	if (
		position.openPrice * (1 - 0.9 * lowerBoundaryBps) < price &&
		position.openPrice * (1 + 0.9 * upperBoundaryBps) > price
	) {
		await wait()
		continue
	}

	// Close position
	await closePosition({
		positionAddress: position.address,
		refetch: false,
		whirlpoolData,
	})

	// Open new position
	const { positionMint, balances } = await openPosition({
		upperBoundaryPrice: higherBoundary,
		lowerBoundaryPrice: lowerBoundary,
		whirlpoolData: await getWhirlpoolData(),
	})
	const positionPDAddress = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint)

	state.data = {
		position: {
			address: positionPDAddress.publicKey,
			openPrice: price,
		},
	}

	// Swap overflow SOL amount to USDC
	await swapRemainingSol(balances)

	await state.write()
	await wait()
}
