import { ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil } from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { USDC_MINT, SOL_USDC_WHIRLPOOL_ADDRESS, SOL_MINT, MIN_SOL_AMOUNT_RAW } from './constants.js'
import { closePosition } from './orca/closePosition.js'
import { getWhirlpoolData } from './orca/getPool.js'
import { openPosition } from './orca/openPosition.js'
import { state } from './state.js'
import { executeJupiterSwap } from './utils/jupiter.js'
import { getQuoteWithBoundaries } from './utils/quote.js'

const wait = () => setTimeout(60_000)

const swapRemainingSol = async (balances: Map<PublicKey, number>) => {
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
}

// INIT
// Open position
if (!state.data?.position) {
	const whirlpoolData = await getWhirlpoolData(SOL_USDC_WHIRLPOOL_ADDRESS)
	const { higherBoundary, lowerBoundary, price } = await getQuoteWithBoundaries({
		whirlpoolAddress: SOL_USDC_WHIRLPOOL_ADDRESS,
		whirlpoolData: whirlpoolData,
	})
	const { positionMint, balances } = await openPosition({
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

	await swapRemainingSol(balances)

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
	if (position.openPrice * 0.98 < price && position.openPrice * 1.02 > price) {
		await wait()
		continue
	}

	// Close position
	await closePosition({
		positionAddress: position.address,
		whirlpoolAddress: SOL_USDC_WHIRLPOOL_ADDRESS,
		refetch: false,
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
	await swapRemainingSol(balances)

	await state.write()
	await wait()
}
