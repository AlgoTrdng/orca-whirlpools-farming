import { ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil } from '@orca-so/whirlpools-sdk'
import { setTimeout } from 'node:timers/promises'

import { USDC_MINT, SOL_USDC_WHIRLPOOL_ADDRESS, SOL_MINT, MIN_SOL_AMOUNT_RAW } from './constants.js'
import { closePosition } from './orca/closePosition.js'
import { getWhirlpoolData } from './orca/getPool.js'
import { openPosition } from './orca/openPosition.js'
import { state } from './state.js'
import { executeJupiterSwap } from './utils/jupiter.js'
import { getQuoteWithBoundaries } from './utils/quote.js'

const wait = () => setTimeout(60_000)

// INIT
// Open position
if (!state.data?.position) {
	const whirlpoolData = await getWhirlpoolData(SOL_USDC_WHIRLPOOL_ADDRESS)
	const { higherBoundary, lowerBoundary, price } = await getQuoteWithBoundaries({
		whirlpoolAddress: SOL_USDC_WHIRLPOOL_ADDRESS,
		whirlpoolData: whirlpoolData,
	})
	const { positionMint } = await openPosition({
		whirlpoolAddress: SOL_USDC_WHIRLPOOL_ADDRESS,
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

	await state.write()
	await wait()
}

// WATCH
while (true) {
	const whirlpoolData = await getWhirlpoolData(SOL_USDC_WHIRLPOOL_ADDRESS)
	const { price, higherBoundary, lowerBoundary } = await getQuoteWithBoundaries({
		whirlpoolAddress: SOL_USDC_WHIRLPOOL_ADDRESS,
		whirlpoolData,
	})

	const position = state.data.position!

	console.log(
		`\nCurrent price: ${price}\n` +
			`Position: \n` +
			` Open price: ${position.openPrice}\n` +
			` Current position price deviation: ${(price / position.openPrice - 1) * 100}`,
	)

	// Check if current is in bounds
	if (price * 1.02 > position.openPrice || price * 0.98 < position.openPrice) {
		await wait()
		continue
	}

	// Close position
	await closePosition({
		positionAddress: position.address,
		whirlpoolData,
	})

	// Open new position
	const { positionMint, balances } = await openPosition({
		upperBoundaryPrice: higherBoundary,
		lowerBoundaryPrice: lowerBoundary,
		whirlpoolAddress: SOL_USDC_WHIRLPOOL_ADDRESS,
		whirlpoolData: await getWhirlpoolData(SOL_USDC_WHIRLPOOL_ADDRESS),
	})
	const positionPDAddress = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint)

	state.data = {
		position: {
			address: positionPDAddress.publicKey,
			openPrice: price,
		},
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

	await state.write()
	await wait()
}
