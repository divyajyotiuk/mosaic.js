/**
 * @typedef {Object} StakeResponse
 *
 * @property {string} messageHash Stake request identifier unique for each request.
 * @property {string} nonce Nonce of the staker address.
 * @property {blockNumber} Block height at which stake is done.
 */

/**
 * @typedef {Object} RedeemResponse
 *
 * @property {string} messageHash Redeem request identifier unique for each request.
 * @property {string} nonce Nonce of the redeemer address.
 * @property {blockNumber} Block height at which redeem is done.
 */

'use strict';

const BN = require('bn.js');
const Web3 = require('web3');
const EIP20Gateway = require('../ContractInteract/EIP20Gateway');
const EIP20CoGateway = require('../ContractInteract/EIP20CoGateway');
const Utils = require('../utils/Utils');
const ProofGenerator = require('../utils/ProofGenerator');
const Message = require('../utils/Message');
const Logger = require('../../logger/Logger');
const Mosaic = require('../Mosaic');

const logger = new Logger('facilitator');
const MessageStatus = Message.messageStatus();

/**
 * Class to facilitate stake and mint.
 */
class Facilitator {
  /**
   * Constructor for facilitator.
   *
   * @param {Mosaic} mosaic Mosaic object.
   */
  constructor(mosaic) {
    if (!(mosaic instanceof Mosaic)) {
      const err = new TypeError('Invalid mosaic object.');
      throw err;
    }
    if (!(mosaic.origin.web3 instanceof Web3)) {
      const err = new TypeError('Invalid origin web3 object.');
      throw err;
    }
    if (!(mosaic.auxiliary.web3 instanceof Web3)) {
      const err = new TypeError('Invalid auxiliary web3 object.');
      throw err;
    }
    if (!Web3.utils.isAddress(mosaic.origin.contractAddresses.EIP20Gateway)) {
      const err = new TypeError(
        `Invalid Gateway address: ${mosaic.origin.contractAddresses.EIP20Gateway}.`,
      );
      throw err;
    }
    if (
      !Web3.utils.isAddress(mosaic.auxiliary.contractAddresses.EIP20CoGateway)
    ) {
      const err = new TypeError(
        `Invalid CoGateway address: ${mosaic.auxiliary.contractAddresses.EIP20CoGateway}.`,
      );
      throw err;
    }

    this.mosaic = mosaic;
    this.gateway = new EIP20Gateway(
      mosaic.origin.web3,
      mosaic.origin.contractAddresses.EIP20Gateway,
    );
    this.coGateway = new EIP20CoGateway(
      mosaic.auxiliary.web3,
      mosaic.auxiliary.contractAddresses.EIP20CoGateway,
    );

    this.stake = this.stake.bind(this);
    this.progressStake = this.progressStake.bind(this);
    this.confirmStakeIntent = this.confirmStakeIntent.bind(this);
    this.progressStakeMessage = this.progressStakeMessage.bind(this);
    this.performProgressStake = this.performProgressStake.bind(this);
    this.performProgressMint = this.performProgressMint.bind(this);
    this.getCoGatewayProof = this.getCoGatewayProof.bind(this);
  }

  /**
   * Performs the stake process.
   *
   * @param {string} staker Staker address.
   * @param {string} amount Stake amount.
   * @param {string} beneficiary Beneficiary address for minting tokens.
   * @param {string} gasPrice Gas price for reward calculation.
   * @param {string} gasLimit Maximum gas for reward calculation.
   * @param {string} hashLock Hash lock.
   * @param {Object} txOption Transaction options.
   *
   * @returns {Promise<StakeResponse>} Promise that resolves to StakeResponse Object.
   */
  async stake(
    staker,
    amount,
    beneficiary,
    gasPrice,
    gasLimit,
    hashLock,
    txOption,
  ) {
    logger.info('Stake');
    logger.info('-----------------------');
    if (!Web3.utils.isAddress(staker)) {
      const err = new TypeError(`Invalid staker address: ${staker}.`);
      return Promise.reject(err);
    }

    if (new BN(amount).eqn(0)) {
      const err = new TypeError(`Stake amount must not be zero: ${amount}.`);
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(beneficiary)) {
      const err = new TypeError(
        `Invalid beneficiary address: ${beneficiary}.`,
      );
      return Promise.reject(err);
    }

    if (typeof gasPrice !== 'string') {
      const err = new TypeError(`Invalid gas price: ${gasPrice}.`);
      return Promise.reject(err);
    }

    if (typeof gasLimit !== 'string') {
      const err = new TypeError(`Invalid gas limit: ${gasLimit}.`);
      return Promise.reject(err);
    }

    if (typeof hashLock !== 'string') {
      const err = new TypeError(`Invalid hash lock: ${hashLock}.`);
      return Promise.reject(err);
    }

    if (!txOption) {
      const err = new TypeError(`Invalid transaction options: ${txOption}.`);
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(txOption.from)) {
      const err = new TypeError(
        `Invalid facilitator address: ${txOption.from}.`,
      );
      return Promise.reject(err);
    }

    const facilitatorAddress = txOption.from;

    if (!await this._isStakeApproved(staker, amount)) {
      if (staker === facilitatorAddress) {
        logger.info(
          '  - As staker is facilitator, approving gateway for token transfer',
        );
        await this._approveStake(amount, txOption);
      } else {
        logger.error('  - Cannot perform stake.');
        const err = new Error('Transfer of stake amount must be approved.');
        return Promise.reject(err);
      }
    }

    if (!await this._isStakeBountyApproved(facilitatorAddress)) {
      await this._approveStakeBounty(txOption);
    }

    const nonce = await this._getStakeNonce(staker);

    logger.info('Performing stake');
    return this.gateway
      .stake(
        amount,
        beneficiary,
        gasPrice,
        gasLimit,
        nonce,
        hashLock,
        txOption,
      )
      .then((stakeReceipt) => {
        logger.win('  - Successfully performed stake.');
        const stakeIntentDeclaredEvent = stakeReceipt.events.StakeIntentDeclared;

        return Promise.resolve({
          nonce: stakeIntentDeclaredEvent.returnValues._stakerNonce,
          messageHash: stakeIntentDeclaredEvent.returnValues._messageHash,
          blockNumber: stakeReceipt.number,
        });
      })
      .catch((exception) => {
        logger.error('  - Failed to perform stake.');
        return Promise.reject(exception);
      });
  }

  /**
   * Perform redeem. When you redeem it is important that the `value` of the `txOptions` is equal to
   * the bounty on the co-gateway.
   *
   * @param {string} redeemer Redeemer address.
   * @param {string} amount Redeem amount
   * @param {string} beneficiary Beneficiary address.
   * @param {string} gasPrice Gas price.
   * @param {string} gasLimit Gas limit.
   * @param {string} hashLock Hash lock;
   * @param {Object} txOptions Transaction options.
   *
   * @returns {Promise<RedeemResponse>} Promise that resolves to an RedeemResponse Object.
   */
  async redeem(
    redeemer,
    amount,
    beneficiary,
    gasPrice,
    gasLimit,
    hashLock,
    txOptions,
  ) {
    logger.info('Redeem');
    logger.info('-----------------------');
    if (!Web3.utils.isAddress(redeemer)) {
      const err = new TypeError(`Invalid redeemer address: ${redeemer}.`);
      return Promise.reject(err);
    }

    if (!new BN(amount).gtn(0)) {
      const err = new TypeError(
        `Redeem amount must be greater than zero: ${amount}.`,
      );
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(beneficiary)) {
      const err = new TypeError(
        `Invalid beneficiary address: ${beneficiary}.`,
      );
      return Promise.reject(err);
    }

    if (typeof gasPrice !== 'string') {
      const err = new TypeError(`Invalid gas price: ${gasPrice}.`);
      return Promise.reject(err);
    }

    if (typeof gasLimit !== 'string') {
      const err = new TypeError(`Invalid gas limit: ${gasLimit}.`);
      return Promise.reject(err);
    }

    if (typeof hashLock !== 'string') {
      const err = new TypeError(`Invalid hash lock: ${hashLock}.`);
      return Promise.reject(err);
    }

    if (!txOptions) {
      const err = new TypeError(`Invalid transaction options: ${txOptions}.`);
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(txOptions.from)) {
      const err = new TypeError(
        `Invalid facilitator address: ${txOptions.from}.`,
      );
      return Promise.reject(err);
    }

    const facilitatorAddress = txOptions.from;

    let bounty;
    try {
      bounty = await this._getRedeemBounty();
    } catch (error) {
      return Promise.reject(error);
    }

    if (!new BN(txOptions.value).eq(new BN(bounty))) {
      const message = `Value passed in transaction object ${txOptions.value} must be equal to bounty amount ${bounty}`;
      logger.error(`  - ${message}`);
      const err = new Error(message);

      return Promise.reject(err);
    }

    let isRedeemApproved;
    try {
      isRedeemApproved = await this._isRedeemApproved(redeemer, amount);
    } catch (error) {
      return Promise.reject(error);
    }

    if (!isRedeemApproved) {
      if (redeemer === facilitatorAddress) {
        try {
          await this._approveRedeem(amount, txOptions);
        } catch (error) {
          return Promise.reject(error);
        }
      } else {
        logger.error('  - Cannot perform redeem.');
        const err = new Error('Transfer of redeem amount must be approved.');
        return Promise.reject(err);
      }
    }

    let nonce;
    try {
      nonce = await this._getRedeemNonce(redeemer);
    } catch (error) {
      return Promise.reject(error);
    }

    logger.info('Performing Redeem');
    return this.coGateway
      .redeem(
        amount,
        beneficiary,
        gasPrice,
        gasLimit,
        nonce,
        hashLock,
        txOptions,
      )
      .then((redeemReceipt) => {
        logger.win('  - Successfully performed redeem.');
        const redeemIntentDeclaredEvent = redeemReceipt.events.RedeemIntentDeclared;

        return Promise.resolve({
          messageHash: redeemIntentDeclaredEvent.returnValues._messageHash,
          nonce: redeemIntentDeclaredEvent.returnValues._redeemerNonce,
          blockNumber: redeemReceipt.number,
        });
      })
      .catch((exception) => {
        logger.error('  - Failed to performed redeem.');
        return Promise.reject(exception);
      });
  }

  /**
   * Performs the progress stake and progress mint.
   *
   * @param {string} staker Staker address.
   * @param {string} amount Stake amount.
   * @param {string} beneficiary Beneficiary address for minting tokens.
   * @param {string} gasPrice Gas price for reward calculation.
   * @param {string} gasLimit Maximum gas for reward calculation.
   * @param {string} nonce Stake nonce.
   * @param {string} hashLock Hash lock.
   * @param {string} unlockSecret Unlock secret.
   * @param {string} blockNumber Block number at which stake was done.
   * @param {Object} txOptionOrigin Transaction options for origin chain.
   * @param {Object} txOptionAuxiliary Transaction options for auxiliary chain.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  progressStake(
    staker,
    amount,
    beneficiary,
    gasPrice,
    gasLimit,
    nonce,
    hashLock,
    unlockSecret,
    blockNumber,
    txOptionOrigin,
    txOptionAuxiliary,
  ) {
    logger.info('Performing stake and mint');
    logger.info('-----------------------');
    if (!Web3.utils.isAddress(staker)) {
      const err = new TypeError(`Invalid staker address: ${staker}.`);
      return Promise.reject(err);
    }

    if (new BN(amount).eqn(0)) {
      const err = new TypeError(
        `Stake amount must be greater than zero: ${amount}.`,
      );
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(beneficiary)) {
      const err = new TypeError(
        `Invalid beneficiary address: ${beneficiary}.`,
      );
      return Promise.reject(err);
    }

    if (typeof gasPrice !== 'string') {
      const err = new TypeError(`Invalid gas price: ${gasPrice}.`);
      return Promise.reject(err);
    }

    if (typeof gasLimit !== 'string') {
      const err = new TypeError(`Invalid gas limit: ${gasLimit}.`);
      return Promise.reject(err);
    }

    if (typeof nonce !== 'string') {
      const err = new TypeError(`Invalid staker nonce: ${nonce}.`);
      return Promise.reject(err);
    }

    if (!txOptionOrigin) {
      const err = new TypeError(
        `Invalid transaction options for origin chain: ${txOptionOrigin}.`,
      );
      return Promise.reject(err);
    }

    if (!txOptionAuxiliary) {
      const err = new TypeError(
        `Invalid transaction options for auxiliary chain: ${txOptionAuxiliary}.`,
      );
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(txOptionOrigin.from)) {
      const err = new TypeError(
        `Invalid origin chain facilitator address: ${txOptionOrigin.from}.`,
      );
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(txOptionAuxiliary.from)) {
      const err = new TypeError(
        `Invalid auxiliary chain facilitator address: ${txOptionAuxiliary.from}.`,
      );
      return Promise.reject(err);
    }

    return this.confirmStakeIntent(
      staker,
      amount,
      beneficiary,
      gasPrice,
      gasLimit,
      nonce,
      hashLock,
      blockNumber,
      txOptionAuxiliary,
    ).then(() => {
      const messageHash = Message.getStakeMessageHash(
        amount,
        beneficiary,
        this.gateway.address,
        nonce,
        gasPrice,
        gasLimit,
        staker,
        hashLock,
      );

      return this.progressStakeMessage(
        messageHash,
        unlockSecret,
        txOptionOrigin,
        txOptionAuxiliary,
      );
    });
  }

  /**
   * Performs the progress redeem and progress unstake.
   *
   * @param {string} redeemer Redeemer address.
   * @param {string} nonce Redeemer nonce.
   * @param {string} beneficiary Beneficiary address for unstaking tokens.
   * @param {string} amount Redeem amount.
   * @param {string} gasPrice Gas price for reward calculation.
   * @param {string} gasLimit Maximum gas for reward calculation.
   * @param {string} nonce Stake nonce.
   * @param {string} hashLock Hash lock.
   * @param {string} unlockSecret Unlock secret.
   * @param {string} blockNumber Block number at which redeem was done.
   * @param {Object} txOptionOrigin Transaction options for origin chain.
   * @param {Object} txOptionAuxiliary Transaction options for auxiliary chain.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  progressRedeem(
    redeemer,
    nonce,
    beneficiary,
    amount,
    gasPrice,
    gasLimit,
    hashLock,
    unlockSecret,
    blockNumber,
    txOptionOrigin,
    txOptionAuxiliary,
  ) {
    logger.info('Performing redeem and unstake');
    logger.info('-----------------------');
    if (!Web3.utils.isAddress(redeemer)) {
      const err = new TypeError(`Invalid redeemer address: ${redeemer}.`);
      return Promise.reject(err);
    }

    if (!new BN(amount).gtn(0)) {
      const err = new TypeError(
        `Redeem amount must be greater than zero: ${amount}.`,
      );
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(beneficiary)) {
      const err = new TypeError(
        `Invalid beneficiary address: ${beneficiary}.`,
      );
      return Promise.reject(err);
    }

    if (typeof gasPrice !== 'string') {
      const err = new TypeError(`Invalid gas price: ${gasPrice}.`);
      return Promise.reject(err);
    }

    if (typeof gasLimit !== 'string') {
      const err = new TypeError(`Invalid gas limit: ${gasLimit}.`);
      return Promise.reject(err);
    }

    if (typeof nonce !== 'string') {
      const err = new TypeError(`Invalid redeemer nonce: ${nonce}.`);
      return Promise.reject(err);
    }

    if (!txOptionOrigin) {
      const err = new TypeError(
        `Invalid transaction options for origin chain: ${txOptionOrigin}.`,
      );
      return Promise.reject(err);
    }

    if (!txOptionAuxiliary) {
      const err = new TypeError(
        `Invalid transaction options for auxiliary chain: ${txOptionAuxiliary}.`,
      );
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(txOptionOrigin.from)) {
      const err = new TypeError(
        `Invalid origin chain facilitator address: ${txOptionOrigin.from}.`,
      );
      return Promise.reject(err);
    }

    if (!Web3.utils.isAddress(txOptionAuxiliary.from)) {
      const err = new TypeError(
        `Invalid auxiliary chain facilitator address: ${txOptionAuxiliary.from}.`,
      );
      return Promise.reject(err);
    }

    return this.confirmRedeemIntent(
      redeemer,
      nonce,
      beneficiary,
      amount,
      gasPrice,
      gasLimit,
      hashLock,
      blockNumber,
      txOptionOrigin,
    ).then(() => {
      const messageHash = Message.getRedeemMessageHash(
        amount,
        beneficiary,
        this.coGateway.address,
        nonce,
        gasPrice,
        gasLimit,
        redeemer,
        hashLock,
      );

      return this.progressRedeemMessage(
        messageHash,
        unlockSecret,
        txOptionOrigin,
        txOptionAuxiliary,
      );
    });
  }

  /**
   * Performs confirm stake intent.
   *
   * @param {string} staker Staker address.
   * @param {string} amount Stake amount.
   * @param {string} beneficiary Beneficiary address for minting tokens.
   * @param {string} gasPrice Gas price for reward calculation.
   * @param {string} gasLimit Maximum gas for reward calculation.
   * @param {string} nonce Stake nonce.
   * @param {string} hashLock Hash lock.
   * @param {string} blockNumber Block number at which stake was done.
   * @param {Object} txOptions Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async confirmStakeIntent(
    staker,
    amount,
    beneficiary,
    gasPrice,
    gasLimit,
    nonce,
    hashLock,
    blockNumber,
    txOptions,
  ) {
    logger.info('Confirming stake intent');
    logger.info('-----------------------');
    if (!Web3.utils.isAddress(staker)) {
      const err = new TypeError(`Invalid staker address: ${staker}.`);
      return Promise.reject(err);
    }
    if (new BN(amount).eqn(0)) {
      const err = new TypeError(
        `Stake amount must be greater than be zero: ${amount}.`,
      );
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(beneficiary)) {
      const err = new TypeError(
        `Invalid beneficiary address: ${beneficiary}.`,
      );
      return Promise.reject(err);
    }
    if (typeof gasPrice !== 'string') {
      const err = new TypeError(`Invalid gas price: ${gasPrice}.`);
      return Promise.reject(err);
    }
    if (typeof gasLimit !== 'string') {
      const err = new TypeError(`Invalid gas limit: ${gasLimit}.`);
      return Promise.reject(err);
    }
    if (typeof nonce !== 'string') {
      const err = new TypeError(`Invalid staker nonce: ${nonce}.`);
      return Promise.reject(err);
    }
    if (typeof hashLock !== 'string') {
      const err = new TypeError(`Invalid hash lock: ${hashLock}.`);
      return Promise.reject(err);
    }
    if (!txOptions) {
      const err = new TypeError(`Invalid transaction options: ${txOptions}.`);
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOptions.from)) {
      const err = new TypeError(
        `Invalid facilitator address: ${txOptions.from}.`,
      );
      return Promise.reject(err);
    }
    if (!blockNumber) {
      const err = new TypeError(`Invalid block height: ${blockNumber}.`);
      return Promise.reject(err);
    }
    const latestAnchorInfo = await this.coGateway.getLatestAnchorInfo();
    if ((new BN(latestAnchorInfo.blockHeight)).lt(new BN(blockNumber))) {
      const errMsg = 'Block number should be less or equal to the latest available state root block height!';
      logger.error(errMsg);
      const err = new Error(errMsg);
      return Promise.reject(err);
    }

    logger.info('Generating message hash with given stake parameters');
    const messageHash = Message.getStakeMessageHash(
      amount,
      beneficiary,
      this.gateway.address,
      nonce,
      gasPrice,
      gasLimit,
      staker,
      hashLock,
    );

    logger.info(`  - Message hash is ${messageHash}`);

    const stakeMessageStatus = await this.gateway
      .getOutboxMessageStatus(messageHash)
      .catch((exception) => {
        logger.error('  - Exception while getting outbox message status');
        return Promise.reject(exception);
      });

    logger.info(`  - Gateway's outbox message hash is ${stakeMessageStatus}`);

    if (stakeMessageStatus === MessageStatus.UNDECLARED) {
      const err = new Error('Stake message hash must be declared.');
      return Promise.reject(err);
    }

    const mintMessageStatus = await this.coGateway
      .getInboxMessageStatus(messageHash)
      .catch((exception) => {
        logger.error('  - Exception while getting inbox message status');
        return Promise.reject(exception);
      });

    logger.info(`  - CoGateway's inbox message hash is ${mintMessageStatus}`);

    if (
      mintMessageStatus === MessageStatus.DECLARED
      || mintMessageStatus === MessageStatus.PROGRESSED
      || mintMessageStatus === MessageStatus.REVOKED
    ) {
      logger.win('  - Stake intent already confirmed on CoGateway');
      return Promise.resolve(true);
    }

    return this.getGatewayProof(messageHash, latestAnchorInfo.blockHeight).then(async (proofData) => {
      logger.info('Proving Gateway account on CoGateway');

      return this.coGateway
        .proveGateway(
          proofData.blockNumber, // Same as latestAnchorInfo.blockHeight
          proofData.accountData,
          proofData.accountProof,
          txOptions,
        )
        .then(() => {
          logger.info('  - Gateway was proven on CoGateway');
          return this.coGateway
            .confirmStakeIntent(
              staker,
              nonce,
              beneficiary,
              amount,
              gasPrice,
              gasLimit,
              hashLock,
              proofData.blockNumber,
              proofData.storageProof,
              txOptions,
            )
            .then((confirmStakeIntentResult) => {
              logger.info('  - Confirm stake intent successful');
              return Promise.resolve(confirmStakeIntentResult);
            })
            .catch((exception) => {
              logger.error('  - Failed to confirm stake intent');
              return Promise.reject(exception);
            });
        })
        .catch((exception) => {
          logger.error('  - Failed to prove gateway account on CoGateway');
          return Promise.reject(exception);
        });
    });
  }

  /**
   * Performs confirm redeem intent.
   *
   * @param {string} redeemer Redeemer address.
   * @param {string} nonce Redeemer nonce.
   * @param {string} beneficiary Beneficiary address.
   * @param {string} amount Redeem amount.
   * @param {string} gasPrice Gas price for reward calculation.
   * @param {string} gasLimit Maximum gas for reward calculation.
   * @param {string} hashLock Hash lock.
   * @param {string} blockNumber Block number at which redeem was done.
   * @param {Object} txOptions Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async confirmRedeemIntent(
    redeemer,
    nonce,
    beneficiary,
    amount,
    gasPrice,
    gasLimit,
    hashLock,
    blockNumber,
    txOptions,
  ) {
    logger.info('Confirming redeem intent');
    logger.info('-----------------------');
    if (!Web3.utils.isAddress(redeemer)) {
      const err = new TypeError(`Invalid redeemer address: ${redeemer}.`);
      return Promise.reject(err);
    }
    if (new BN(amount).eqn(0)) {
      const err = new TypeError(
        `Redeem amount must be greater than zero: ${amount}.`,
      );
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(beneficiary)) {
      const err = new TypeError(
        `Invalid beneficiary address: ${beneficiary}.`,
      );
      return Promise.reject(err);
    }
    if (typeof gasPrice !== 'string') {
      const err = new TypeError(`Invalid gas price: ${gasPrice}.`);
      return Promise.reject(err);
    }
    if (typeof gasLimit !== 'string') {
      const err = new TypeError(`Invalid gas limit: ${gasLimit}.`);
      return Promise.reject(err);
    }
    if (typeof nonce !== 'string') {
      const err = new TypeError(`Invalid redeemer nonce: ${nonce}.`);
      return Promise.reject(err);
    }
    if (typeof hashLock !== 'string') {
      const err = new TypeError(`Invalid hash lock: ${hashLock}.`);
      return Promise.reject(err);
    }
    if (!txOptions) {
      const err = new TypeError(`Invalid transaction options: ${txOptions}.`);
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOptions.from)) {
      const err = new TypeError(
        `Invalid facilitator address: ${txOptions.from}.`,
      );
      return Promise.reject(err);
    }
    if (!blockNumber) {
      const err = new TypeError(`Invalid block height: ${blockNumber}.`);
      return Promise.reject(err);
    }
    const latestAnchorInfo = await this.gateway.getLatestAnchorInfo();
    if ((new BN(latestAnchorInfo.blockHeight)).lt(new BN(blockNumber))) {
       const errMsg = 'Block number should be less or equal to the latest available state root block height!';
      logger.error(errMsg);
      const err = new Error(errMsg);
      return Promise.reject(err);
    }

    logger.info('Generating message hash with given redeem parameters');
    const messageHash = Message.getRedeemMessageHash(
      amount,
      beneficiary,
      this.coGateway.address,
      nonce,
      gasPrice,
      gasLimit,
      redeemer,
      hashLock,
    );

    logger.info(`  - Message hash is ${messageHash}`);

    const redeemMessageStatus = await this.coGateway
      .getOutboxMessageStatus(messageHash)
      .catch((exception) => {
        logger.error('  - Exception while getting outbox message status');
        return Promise.reject(exception);
      });

    logger.info(
      `  - CoGateway's outbox message hash is ${redeemMessageStatus}`,
    );

    if (redeemMessageStatus === MessageStatus.UNDECLARED) {
      const err = new Error('Redeem message hash must be declared.');
      return Promise.reject(err);
    }

    const unstakeMessageStatus = await this.gateway
      .getInboxMessageStatus(messageHash)
      .catch((exception) => {
        logger.error('  - Exception while getting inbox message status');
        return Promise.reject(exception);
      });

    logger.info(`  - Gateway's inbox message hash is ${unstakeMessageStatus}`);

    if (
      unstakeMessageStatus === MessageStatus.DECLARED
      || unstakeMessageStatus === MessageStatus.PROGRESSED
      || unstakeMessageStatus === MessageStatus.REVOKED
    ) {
      logger.win('  - Redeem intent already confirmed on Gateway');
      return Promise.resolve(true);
    }

    return this.getCoGatewayProof(messageHash, latestAnchorInfo.blockHeight).then(async (proofData) => {
      logger.info('Proving CoGateway account on Gateway');
      return this.gateway
        .proveGateway(
          proofData.blockNumber, // Same as latestAnchorInfo.blockHeight
          proofData.accountData,
          proofData.accountProof,
          txOptions,
        )
        .then(() => {
          logger.info('  - CoGateway was proven on Gateway');
          return this.gateway
            .confirmRedeemIntent(
              redeemer,
              nonce,
              beneficiary,
              amount,
              gasPrice,
              gasLimit,
              proofData.blockNumber,
              hashLock,
              proofData.storageProof,
              txOptions,
            )
            .then((confirmRedeemIntentResult) => {
              logger.win('  - Confirm redeem intent is successful');
              return Promise.resolve(confirmRedeemIntentResult);
            })
            .catch((exception) => {
              logger.error('  - Failed to confirm redeem intent');
              return Promise.reject(exception);
            });
        })
        .catch((exception) => {
          logger.error('  - Failed to prove CoGateway account on Gateway');
          return Promise.reject(exception);
        });
    });
  }

  /**
   * Performs progress stake and progress mint.
   *
   * @param {string} messageHash Message hash.
   * @param {string} unlockSecret Unlock secret for progress stake.
   * @param {Object} txOptionOrigin Transaction options for origin chain.
   * @param {Object} txOptionAuxiliary Transaction options for auxiliary chain.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async progressStakeMessage(
    messageHash,
    unlockSecret,
    txOptionOrigin,
    txOptionAuxiliary,
  ) {
    logger.info('Performing progress stake and progress mint');
    logger.info('-----------------------');
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (typeof unlockSecret !== 'string') {
      const err = new TypeError(`Invalid unlock secret: ${unlockSecret}.`);
      return Promise.reject(err);
    }
    if (txOptionOrigin === undefined) {
      const err = new TypeError(
        `Invalid origin transaction option: ${txOptionOrigin}.`,
      );
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOptionOrigin.from)) {
      const err = new TypeError(
        `Invalid from address ${txOptionOrigin.from} in origin transaction options.`,
      );
      return Promise.reject(err);
    }
    if (txOptionAuxiliary === undefined) {
      const err = new TypeError(
        `Invalid auxiliary transaction option: ${txOptionAuxiliary}.`,
      );
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOptionAuxiliary.from)) {
      const err = new TypeError(
        `Invalid from address ${txOptionAuxiliary.from} in auxiliary transaction options.`,
      );
      return Promise.reject(err);
    }

    return Promise.all([
      this.performProgressStake(messageHash, unlockSecret, txOptionOrigin),
      this.performProgressMint(messageHash, unlockSecret, txOptionAuxiliary),
    ]);
  }

  /**
   * Performs progress redeem and progress unstake.
   *
   * @param {string} messageHash Message hash.
   * @param {string} unlockSecret Unlock secret for progress stake.
   * @param {Object} txOptionOrigin Transaction options for origin chain.
   * @param {Object} txOptionAuxiliary Transaction options for auxiliary chain.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async progressRedeemMessage(
    messageHash,
    unlockSecret,
    txOptionOrigin,
    txOptionAuxiliary,
  ) {
    logger.info('Performing progress redeem and progress unstake');
    logger.info('-----------------------');
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (typeof unlockSecret !== 'string') {
      const err = new TypeError(`Invalid unlock secret: ${unlockSecret}.`);
      return Promise.reject(err);
    }
    if (txOptionOrigin === undefined) {
      const err = new TypeError(
        `Invalid origin transaction option: ${txOptionOrigin}.`,
      );
      return Promise.reject(err);
    }
    if (txOptionAuxiliary === undefined) {
      const err = new TypeError(
        `Invalid auxiliary transaction option: ${txOptionAuxiliary}.`,
      );
      return Promise.reject(err);
    }

    return Promise.all([
      this.performProgressRedeem(messageHash, unlockSecret, txOptionAuxiliary),
      this.performProgressUnstake(
        messageHash,
        unlockSecret,
        txOptionOrigin,
      ),
    ]);
  }

  /**
   * Performs progress stake.
   *
   * @param {string} messageHash Message hash.
   * @param {string} unlockSecret Unlock secret for progress stake.
   * @param {Object} txOption Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async performProgressStake(messageHash, unlockSecret, txOption) {
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (typeof unlockSecret !== 'string') {
      const err = new TypeError(`Invalid unlock secret: ${unlockSecret}.`);
      return Promise.reject(err);
    }
    if (txOption === undefined) {
      const err = new TypeError(`Invalid transaction option: ${txOption}.`);
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOption.from)) {
      const err = new TypeError(
        `Invalid from address ${txOption.from} in transaction options.`,
      );
      return Promise.reject(err);
    }

    const stakeMessageStatus = await this.gateway
      .getOutboxMessageStatus(messageHash)
      .catch(exception => Promise.reject(exception));

    logger.info(
      `  - Gateway's outbox message status is ${stakeMessageStatus}`,
    );

    if (
      stakeMessageStatus === MessageStatus.UNDECLARED
      || stakeMessageStatus === MessageStatus.REVOCATION_DECLARED
      || stakeMessageStatus === MessageStatus.REVOKED
    ) {
      logger.error('  - Cannot perform progress stake.');
      const err = Error('Message cannot be progressed.');
      return Promise.reject(err);
    }

    if (stakeMessageStatus === MessageStatus.PROGRESSED) {
      logger.win('  - Progress stake is already done.');
      return Promise.resolve(true);
    }

    return this.gateway
      .progressStake(messageHash, unlockSecret, txOption)
      .then((progressStakeResult) => {
        logger.win('  - Progress stake successful.');
        return Promise.resolve(progressStakeResult);
      })
      .catch((exception) => {
        logger.error('  - Failed to progress stake.');
        return Promise.reject(exception);
      });
  }

  /**
   * Performs progress mint.
   *
   * @param {string} messageHash Message hash.
   * @param {string} unlockSecret Unlock secret for progress stake.
   * @param {Object} txOption Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async performProgressMint(messageHash, unlockSecret, txOption) {
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (typeof unlockSecret !== 'string') {
      const err = new TypeError(`Invalid unlock secret: ${unlockSecret}.`);
      return Promise.reject(err);
    }
    if (txOption === undefined) {
      const err = new TypeError(`Invalid transaction option: ${txOption}.`);
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOption.from)) {
      const err = new TypeError(
        `Invalid from address ${txOption.from} in transaction options.`,
      );
      return Promise.reject(err);
    }

    const mintMessageStatus = await this.coGateway
      .getInboxMessageStatus(messageHash)
      .catch(exception => Promise.reject(exception));

    logger.info(
      `  - CoGateway's inbox message status is ${mintMessageStatus}`,
    );

    if (
      mintMessageStatus === MessageStatus.UNDECLARED
      || mintMessageStatus === MessageStatus.REVOKED
      || mintMessageStatus === MessageStatus.REVOCATION_DECLARED
    ) {
      logger.error('  - Cannot perform progress mint.');
      const err = new TypeError('Message cannot be progressed.');
      return Promise.reject(err);
    }

    if (mintMessageStatus === MessageStatus.PROGRESSED) {
      logger.win('  - Progress mint is already done.');
      return Promise.resolve(true);
    }

    return this.coGateway
      .progressMint(messageHash, unlockSecret, txOption)
      .then((progressMintResult) => {
        logger.win('  - Progress mint successful.');
        return Promise.resolve(progressMintResult);
      })
      .catch((exception) => {
        logger.error('  - Failed to progress mint.');
        return Promise.reject(exception);
      });
  }

  /**
   * Performs progress unstake.
   *
   * @param {string} messageHash Message hash.
   * @param {string} unlockSecret Unlock secret for progress stake.
   * @param {Object} txOption Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async performProgressUnstake(messageHash, unlockSecret, txOption) {
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (typeof unlockSecret !== 'string') {
      const err = new TypeError(`Invalid unlock secret: ${unlockSecret}.`);
      return Promise.reject(err);
    }
    if (txOption === undefined) {
      const err = new TypeError(`Invalid transaction option: ${txOption}.`);
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOption.from)) {
      const err = new TypeError(
        `Invalid from address ${txOption.from} in transaction options.`,
      );
      return Promise.reject(err);
    }

    const unstakeMessageStatus = await this.gateway
      .getInboxMessageStatus(messageHash)
      .catch(exception => Promise.reject(exception));

    logger.info(
      `  - Gateway's inbox message status is ${unstakeMessageStatus}`,
    );

    if (
      unstakeMessageStatus === MessageStatus.UNDECLARED
      || unstakeMessageStatus === MessageStatus.REVOKED
      || unstakeMessageStatus === MessageStatus.REVOCATION_DECLARED
    ) {
      logger.info('  - Cannot perform progress unstake.');
      const err = new TypeError('Message cannot be progressed.');
      return Promise.reject(err);
    }

    if (unstakeMessageStatus === MessageStatus.PROGRESSED) {
      logger.info('  - Progress unstake is already done.');
      return Promise.resolve(true);
    }

    return this.gateway
      .progressUnstake(messageHash, unlockSecret, txOption)
      .then((progressUnstakeResult) => {
        logger.win('  - Progress unstake is successful.');
        return Promise.resolve(progressUnstakeResult);
      })
      .catch((exception) => {
        logger.error('  - Failed to progress unstake.');
        return Promise.reject(exception);
      });
  }

  /**
   * Performs progress redeem.
   *
   * @param {string} messageHash Message hash.
   * @param {string} unlockSecret Unlock secret for progress stake.
   * @param {Object} txOption Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  async performProgressRedeem(messageHash, unlockSecret, txOption) {
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (typeof unlockSecret !== 'string') {
      const err = new TypeError(`Invalid unlock secret: ${unlockSecret}.`);
      return Promise.reject(err);
    }
    if (txOption === undefined) {
      const err = new TypeError(`Invalid transaction option: ${txOption}.`);
      return Promise.reject(err);
    }
    if (!Web3.utils.isAddress(txOption.from)) {
      const err = new TypeError(
        `Invalid from address ${txOption.from} in transaction options.`,
      );
      return Promise.reject(err);
    }

    const redeemMessageStatus = await this.coGateway
      .getOutboxMessageStatus(messageHash)
      .catch(exception => Promise.reject(exception));

    logger.info(
      `  - CoGateway's outbox message status is ${redeemMessageStatus}`,
    );

    if (
      redeemMessageStatus === MessageStatus.UNDECLARED
      || redeemMessageStatus === MessageStatus.REVOCATION_DECLARED
      || redeemMessageStatus === MessageStatus.REVOKED
    ) {
      logger.info('  - Cannot perform progress redeem.');
      const err = Error('Message cannot be progressed.');
      return Promise.reject(err);
    }

    if (redeemMessageStatus === MessageStatus.PROGRESSED) {
      logger.info('  - Progress redeem is already done.');
      return Promise.resolve(true);
    }

    return this.coGateway
      .progressRedeem(messageHash, unlockSecret, txOption)
      .then((progressStakeResult) => {
        logger.win('  - Progress redeem is successful.');
        return Promise.resolve(progressStakeResult);
      })
      .catch((exception) => {
        logger.error('  - Failed to progress redeem.');
        return Promise.reject(exception);
      });
  }

  /**
   * Gets the gateway proof and validates it.
   *
   * @param {string} messageHash Message hash.
   * @param {string} blockNumber Block height at which proof is fetched.
   *
   * @returns {Promise<Object>} Promise that resolves to Gateway proof data.
   */
  getGatewayProof(messageHash, blockNumber) {
    logger.info('Generating Gateway proof data');
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (!blockNumber) {
      const err = new TypeError(`Invalid block height: ${blockNumber}.`);
      return Promise.reject(err);
    }

    const proofGenerator = new ProofGenerator(
      this.mosaic.origin.web3,
      this.mosaic.auxiliary.web3,
    );
    return Facilitator._getProof(
      proofGenerator,
      this.gateway.address,
      blockNumber,
      messageHash,
    );
  }

  /**
   * Gets the CoGateway proof and validates it.
   *
   * @param {string} messageHash Message hash.
   * @param {string} blockNumber Block height at which proof is fetched.
   *
   * @returns {Promise<Object>} Promise that resolves to CoGateway proof data.
   */
  getCoGatewayProof(messageHash, blockNumber) {
    logger.info('Generating CoGateway proof data');
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}.`);
      return Promise.reject(err);
    }
    if (!blockNumber) {
      const err = new TypeError(`Invalid block height: ${blockNumber}.`);
      return Promise.reject(err);
    }

    const proofGenerator = new ProofGenerator(
      this.mosaic.auxiliary.web3,
      this.mosaic.origin.web3,
    );
    return Facilitator._getProof(
      proofGenerator,
      this.coGateway.address,
      blockNumber,
      messageHash,
    );
  }

  /**
   * Gets the proof and validates it.
   * @private
   * @param {Object} proofGenerator ProofGenerator instance.
   * @param {string} accountAddress Account address.
   * @param {Object} blockNumber Block height at which proof is fetched.
   * @param {string} messageHash Message hash.
   *
   * @returns {Promise<Object>} Promise that resolves to proof data.
   */
  static async _getProof(
    proofGenerator,
    accountAddress,
    blockNumber,
    messageHash,
  ) {
    if (proofGenerator === undefined) {
      const err = new TypeError(
        `Invalid proof generator object: ${proofGenerator}`,
      );
      return Promise.reject(err);
    }
    if (typeof accountAddress !== 'string') {
      const err = new TypeError(`Invalid account address: ${accountAddress}`);
      return Promise.reject(err);
    }
    if (blockNumber === undefined) {
      const err = new TypeError(
        `Invalid block number: ${blockNumber}`,
      );
      return Promise.reject(err);
    }
    if (typeof messageHash !== 'string') {
      const err = new TypeError(`Invalid message hash: ${messageHash}`);
      return Promise.reject(err);
    }
    logger.info(
      `  - Last committed block height is ${blockNumber}`,
    );

    const blockHeight = `0x${new BN(blockNumber).toString(
      16,
    )}`;

    logger.info('Generating proof data');

    logger.info('  - Attempting to generate proof');

    return proofGenerator
      .getOutboxProof(accountAddress, [messageHash], blockHeight)
      .then((proof) => {
        logger.win('  - Proof generation successful');
        return {
          accountData: proof.encodedAccountValue,
          accountProof: proof.serializedAccountProof,
          storageProof: proof.storageProof[0].serializedProof,
          blockNumber: blockNumber,
        };
      })
      .catch((exception) => {
        logger.error('  - Failed to generate proof');
        return Promise.reject(exception);
      });
  }

  /**
   * Helper function to generate hash lock and unlock secrete. If unlock secret
   * is provided then it will generate the hash lock.
   *
   * @param {string} unlockSecret Unlock secret.
   *
   * @returns {Object} An object containing hash lock and unlock secret.
   */
  static getHashLock(unlockSecret) {
    let hashLock = {};

    if (unlockSecret === undefined) {
      hashLock = Utils.createSecretHashLock();
    } else {
      hashLock = Utils.toHashLock(unlockSecret);
    }

    return hashLock;
  }

  /**
   * Checks if a given stake amount is approved to be transferred to the gateway.
   * @private
   * @param {string} staker The address of the staker that the tokens should be transferred from.
   * @param {string} amount The amount to stake.
   *
   * @returns {bool} True if the transfer has been approved.
   */
  async _isStakeApproved(staker, amount) {
    logger.info('Checking if staker has approved gateway for token transfer');
    const isStakeAmountApproved = await this.gateway
      .isStakeAmountApproved(staker, amount)
      .catch((exception) => {
        logger.error('  - Exception while checking stake amount approval');
        return Promise.reject(exception);
      });

    logger.info(`  - Approval status is ${isStakeAmountApproved}`);

    return isStakeAmountApproved;
  }

  /**
   * Approves the amount to be transferred to the gateway.
   * @private
   * @param {string} amount The amount to approve.
   * @param {Object} txOption Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  _approveStake(amount, txOption) {
    return this.gateway
      .approveStakeAmount(amount, txOption)
      .catch((exception) => {
        logger.error(
          '  - Failed to approve gateway contract for token transfer',
        );
        return Promise.reject(exception);
      });
  }

  /**
   * Checks if a given bounty amount is approved to be transferred to the gateway.
   * @private
   * @param {string} facilitatorAddress The address of the facilitator that executes the stake.
   *
   * @returns {bool} True if the transfer has been approved.
   */
  async _isStakeBountyApproved(facilitatorAddress) {
    logger.info(
      'Checking if facilitator has approved gateway for bounty token transfer',
    );
    const isBountyAmountApproved = await this.gateway
      .isBountyAmountApproved(facilitatorAddress)
      .catch((exception) => {
        logger.error('  - Exception while checking bounty amount approval');
        return Promise.reject(exception);
      });

    logger.info(`  - Approval status is ${isBountyAmountApproved}`);

    return isBountyAmountApproved;
  }

  /**
   * Approves the amount to be transferred as bounty.
   * @private
   * @param {Object} txOption Transaction options.
   *
   * @returns {Promise<Object>} Promise that resolves to transaction receipt.
   */
  _approveStakeBounty(txOption) {
    logger.info('  - Approving gateway contract for bounty transfer');
    return this.gateway.approveBountyAmount(txOption).catch((exception) => {
      logger.error(
        '  - Failed to approve gateway contract for bounty transfer',
      );
      return Promise.reject(exception);
    });
  }

  /**
   * Returns the current nonce for the given staker at the gateway of this Facilitator.
   * @private
   * @param {string} staker Address of the staker account.
   *
   * @returns {string} The current nonce from the gateway.
   */
  async _getStakeNonce(staker) {
    logger.info('Getting nonce for the staker account');
    const nonce = await this.gateway.getNonce(staker).catch((exception) => {
      logger.error('  - Failed to get staker nonce');
      return Promise.reject(exception);
    });
    logger.info(`  - Staker's nonce is ${nonce}`);

    return nonce;
  }

  /**
   * Returns the bounty amount required to do a redeem.
   * @private
   *
   * @throws when the co-gateway could not be called.
   */
  async _getRedeemBounty() {
    logger.info('Getting bounty amount');
    const bounty = await this.coGateway.getBounty().catch((exception) => {
      logger.error('  - Exception while getting bounty amount');
      throw exception;
    });

    return bounty;
  }

  /**
   * Returns true if the redeem amount has been approved on the utility token.
   * @private
   * @param {string} redeemer The address of the redeemer.
   * @param {string} amount The amount to redeem.
   *
   * @throws when the co-gateway could not be called.
   */
  async _isRedeemApproved(redeemer, amount) {
    logger.info('Checking if redeemer has approved CoGateway for token transfer');

    const isRedeemAmountApproved = await this.coGateway
      .isRedeemAmountApproved(redeemer, amount)
      .catch((exception) => {
        logger.error('  - Exception while checking redeem amount approval');
        throw exception;
      });

    logger.info(`  - Approval status is ${isRedeemAmountApproved}`);

    return isRedeemAmountApproved;
  }

  /**
   * Approves the redeem amount from the sender to the co-gateway on the utility token.
   * @private
   * @param {string} amount Amount to approve.
   * @param {Object} txOptions Web3 transaction options.
   *
   * @throws when the amount could not be approved.
   */
  async _approveRedeem(amount, txOptions) {
    logger.info('  - As Redeemer is facilitator, approving CoGateway for token transfer');

    const approvalTxOption = Object.assign({}, txOptions);
    delete approvalTxOption.value;

    await this.coGateway
      .approveRedeemAmount(amount, approvalTxOption)
      .catch((exception) => {
        logger.error(
          '  - Failed to approve CoGateway contract for token transfer',
        );
        throw exception;
      });

    logger.info('  - Approval done.');
  }

  /**
   * Returns the current nonce for the redeemer address.
   * @private
   * @param {string} redeemer Address of the redeemer.
   *
   * @throws when the co-gateway could not be called.
   */
  async _getRedeemNonce(redeemer) {
    logger.info('Getting nonce for the redeemer account');

    const nonce = await this.coGateway
      .getNonce(redeemer)
      .catch((exception) => {
        logger.error('  - Failed to get redeemer nonce');
        throw exception;
      });

    logger.info(`  - Redeemer's nonce is ${nonce}`);

    return nonce;
  }
}

module.exports = Facilitator;
