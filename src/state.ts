import { PositionData } from '@orca-so/whirlpools-sdk'
import { PublicKey } from '@solana/web3.js'

type State = {
	position: {
		address: PublicKey
		openPrice: number
		tickLowerIndex: number
		tickUpperIndex: number
		tickArrayAddress: PublicKey
	} | null
}

export const state: State = {
	position: null,
}
