import { PublicKey } from '@solana/web3.js'

declare module '@solana/spl-token' {
	export function getAssociatedTokenAddressSync(
		mint: PublicKey,
		owner: PublicKey,
		allowOwnerOffCurve?: boolean,
		programId?: PublicKey,
		associatedTokenProgramId?: PublicKey,
	): PublicKey

	export interface RawAccount {
		mint: PublicKey
		owner: PublicKey
		amount: bigint
		delegateOption: 1 | 0
		delegate: PublicKey
		state: AccountState
		isNativeOption: 1 | 0
		isNative: bigint
		delegatedAmount: bigint
		closeAuthorityOption: 1 | 0
		closeAuthority: PublicKey
	}
}
