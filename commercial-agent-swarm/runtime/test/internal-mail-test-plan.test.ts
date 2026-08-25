import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInternalMailTestPlan } from '../src/internal-mail-test-plan.js';

describe('internal mail test plan', () => {
  it('is exact, inert and hash-bound without a mission or approval', () => {
    const plan = buildInternalMailTestPlan(new Date('2026-08-25T12:00:00.000Z'));
    assert.equal(plan.sender, 'ventas@proptimiza.com');
    assert.equal(plan.recipient, 'contacto@proptimiza.com');
    assert.equal(plan.volume, 1);
    assert.equal(plan.policyVersion, 'policy-v1');
    assert.equal(plan.executionAllowed, false);
    assert.equal(plan.trackingPixels, false);
    assert.equal(plan.trackingLinks, false);
    assert.equal(plan.automaticFollowUp, false);
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
    assert.equal(plan.provenance.synthetic, false);
    assert.equal('missionId' in plan, false);
    assert.equal('approvalToken' in plan, false);
  });
});
