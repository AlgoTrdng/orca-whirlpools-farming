import { ORCA_WHIRLPOOLS_CONFIG, ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil } from '@orca-so/whirlpools-sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { setTimeout } from 'node:timers/promises'

import { USDC_MINT, SOL_USDC_WHIRLPOOL_ADDRESS, SOL_MINT } from './constants.js'
import { connection, ctx, fetcher, whirlpoolClient } from './global.js'
import { openPosition } from './orca/openPosition.js'
import { state } from './state.js'
import { getQuote, getAvgPriceWithBoundaries } from './utils/quote.js'

const solWhirlpool = await whirlpoolClient.getPool(SOL_USDC_WHIRLPOOL_ADDRESS, true)
const whirlpoolData = solWhirlpool.getData()

// INIT
// Open position

// WATCH
// Compare current price against position price
// If current price shifts 2% up or down from position price , close position and open new one with new price

while (true) {
	const { higherBoundary, lowerBoundary, price } = await getAvgPriceWithBoundaries({
		whirlpool: solWhirlpool,
		inputMint: SOL_MINT,
		inputAmountUi: 1,
	})

	console.log(price)

	const { positionMint } = await openPosition({
		whirlpool: solWhirlpool,
		whirlpoolData,
		upperBoundaryPrice: higherBoundary,
		lowerBoundaryPrice: lowerBoundary,
	})

	const positionPDAddress = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint)
	const position = await fetcher.getPosition(positionPDAddress.publicKey, true)

	console.log(positionPDAddress.publicKey.toString())

	await setTimeout(60_000)
}
