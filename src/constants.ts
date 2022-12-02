import { Percentage } from '@orca-so/common-sdk'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'

export const SOL_USDC_WHIRLPOOL_ADDRESS = new PublicKey(
	'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ',
)

export const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

export const RANGE_SPACING_BPS = 0.04

export const SLIPPAGE_TOLERANCE = new Percentage(new BN(25), new BN(10000))
