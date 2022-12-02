import { PublicKey } from '@solana/web3.js'

type State = {
  positionMint: PublicKey | null
}

export const state: State = {
  positionMint: null,
}
