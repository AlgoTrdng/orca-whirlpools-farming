import { ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil } from '@orca-so/whirlpools-sdk'
import { setTimeout } from 'node:timers/promises'

import { USDC_MINT, SOL_USDC_WHIRLPOOL_ADDRESS, SOL_MINT, MIN_SOL_AMOUNT_RAW } from './constants.js'
import { whirlpoolClient } from './global.js'
import { closePosition } from './orca/closePosition.js'
import { openPosition } from './orca/openPosition.js'
import { state } from './state.js'
import { executeJupiterSwap } from './utils/jupiter.js'
import { getAvgPriceWithBoundaries } from './utils/quote.js'

const solWhirlpool = await whirlpoolClient.getPool(SOL_USDC_WHIRLPOOL_ADDRESS, true)
const whirlpoolData = solWhirlpool.getData()

const wait = () => setTimeout(60_000)

// INIT
// Open position
if (!state.position) {
	const { higherBoundary, lowerBoundary, price } = await getAvgPriceWithBoundaries(solWhirlpool)

	const { positionMint } = await openPosition({
		whirlpool: solWhirlpool,
		whirlpoolData,
		upperBoundaryPrice: higherBoundary,
		lowerBoundaryPrice: lowerBoundary,
	})
	const positionPDAddress = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint)

	state.position = {
		address: positionPDAddress.publicKey,
		openPrice: price,
	}

	await wait()
}

// WATCH
while (true) {
	const { price, higherBoundary, lowerBoundary } = await getAvgPriceWithBoundaries(solWhirlpool)

	console.log(
		`Current price: ${price}\n` +
		`Position: \n` +
		` Open price: ${state.position.openPrice}\n` +
		` Current position shift: ${price / state.position.openPrice - 1}`,
	)

	// Check if current is in bounds
	if (price * 1.02 > state.position.openPrice || price * 0.98 < state.position.openPrice) {
		await wait()
		continue
	}

	// Close position
	await closePosition({
		positionAddress: state.position.address,
		whirlpoolData,
	})

	// Open new position
	const { positionMint, balances } = await openPosition({
		upperBoundaryPrice: higherBoundary,
		lowerBoundaryPrice: lowerBoundary,
		whirlpool: solWhirlpool,
		whirlpoolData,
	})
	const positionPDAddress = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint)

	state.position = {
		address: positionPDAddress.publicKey,
		openPrice: price,
	}

	// Swap overflow SOL amount to USDC
	const solBalance = balances.get(SOL_MINT)
	const overflowAmount = Number(solBalance) - MIN_SOL_AMOUNT_RAW
	if (overflowAmount > MIN_SOL_AMOUNT_RAW * 1.4) {
		console.log(`Swapping overflow SOL amount to USDC: ${overflowAmount}`)
		await executeJupiterSwap({
			inputMint: SOL_MINT,
			outputMint: USDC_MINT,
			amountRaw: overflowAmount,
			swapMode: 'ExactIn',
		})
	}

	await wait()
}
