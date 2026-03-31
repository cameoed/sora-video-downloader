const assert = require('assert');
const {
  extractOwnerIdentity,
  sameOwnerIdentity,
  shouldExcludeAppearanceOwner,
} = require('../uv-backup-logic.js');

function testAppearanceOwnerResolutionPrefersExplicitProfileIdentity() {
  const owner = extractOwnerIdentity({
    post: {
      id: 's_post_123',
      shared_by: 'current-user-id',
    },
    profile: {
      username: 'actual-owner',
      user_id: 'actual-owner-id',
    },
  });

  assert.deepStrictEqual(owner, {
    handle: 'actual-owner',
    id: 'actual-owner-id',
  });
}

function testSameOwnerIdentityDoesNotTreatConflictingHandleAsMatch() {
  assert.strictEqual(
    sameOwnerIdentity(
      { handle: 'actual-owner', id: 'current-user-id' },
      { handle: 'current-user', id: 'current-user-id' }
    ),
    false
  );
}

function testAppearanceOwnerFilterKeepsCastInItemsOwnedBySomeoneElse() {
  assert.strictEqual(
    shouldExcludeAppearanceOwner(
      { handle: 'actual-owner', id: 'current-user-id' },
      { handle: 'current-user', id: 'current-user-id' }
    ),
    false
  );
}

function run() {
  testAppearanceOwnerResolutionPrefersExplicitProfileIdentity();
  testSameOwnerIdentityDoesNotTreatConflictingHandleAsMatch();
  testAppearanceOwnerFilterKeepsCastInItemsOwnedBySomeoneElse();
}

run();
