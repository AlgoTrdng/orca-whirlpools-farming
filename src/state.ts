import { PublicKey } from '@solana/web3.js'

type State = {
	position: {
		address: PublicKey
		openPrice: number
	} | null
}

export const state: State = {
	position: null,
}
