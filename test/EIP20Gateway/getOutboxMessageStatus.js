const chai = require('chai');
const Web3 = require('web3');
const sinon = require('sinon');
const EIP20Gateway = require('../../src/ContractInteract/EIP20Gateway');
const SpyAssert = require('../../test_utils/SpyAssert');
const AssertAsync = require('../../test_utils/AssertAsync');
const Message = require('../../src/utils/Message');

const MessageStatus = Message.messageStatus();
const assert = chai.assert;

describe('EIP20Gateway.getOutboxMessageStatus()', () => {
  let web3;
  let gatewayAddress;
  let gateway;

  let mockedMessageStatus;
  let messageHash;

  let spyMethod;
  let spyCall;

  const setup = () => {
    spyMethod = sinon.replace(
      gateway.contract.methods,
      'getOutboxMessageStatus',
      sinon.fake.returns(() => {
        return Promise.resolve(mockedMessageStatus);
      }),
    );

    spyCall = sinon.spy(gateway, 'getOutboxMessageStatus');
  };

  const tearDown = () => {
    sinon.restore();
    spyCall.restore();
  };

  beforeEach(() => {
    web3 = new Web3();
    gatewayAddress = '0x0000000000000000000000000000000000000002';
    gateway = new EIP20Gateway(web3, gatewayAddress);
    mockedMessageStatus = MessageStatus.DECLARED;
    messageHash =
      '0x0000000000000000000000000000000000000000000000000000000000000222';
  });

  it('should throw an error when message hash is undefined', async () => {
    await AssertAsync.reject(
      gateway.getOutboxMessageStatus(),
      `Invalid message hash: ${undefined}.`,
    );
  });

  it('should return correct mocked message status', async () => {
    setup();
    const result = await gateway.getOutboxMessageStatus(messageHash);
    assert.strictEqual(
      result,
      mockedMessageStatus,
      'Function should return mocked message status.',
    );

    SpyAssert.assert(spyMethod, 1, [[messageHash]]);
    SpyAssert.assert(spyCall, 1, [[messageHash]]);
    tearDown();
  });
});