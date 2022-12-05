import { PublicKey, TransactionInstruction } from '@solana/web3.js'

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

	export function createAssociatedTokenAccountInstruction(
		payer: PublicKey,
		associatedToken: PublicKey,
		owner: PublicKey,
		mint: PublicKey,
		programId?: PublicKey,
		associatedTokenProgramId?: PublicKey,
	): TransactionInstruction

	export function createCloseAccountInstruction(
		account: PublicKey,
		destination: PublicKey,
		authority: PublicKey,
		multiSigners?: Signer[],
		programId?: PublicKey,
	): TransactionInstruction

	export function createSyncNativeInstruction(
		account: PublicKey,
		programId?: PublicKey,
	): TransactionInstruction
}
