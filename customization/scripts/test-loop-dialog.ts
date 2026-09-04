import assert from "node:assert/strict";
import { executeVoiceCommand } from "../src/extension/commands";
import { buildLoopFollowUpCommand, isLoopFollowUpCancellation } from "../src/extension/loop-dialog";

const request = await executeVoiceCommand("loop song part");
assert.equal(typeof request, "object");
assert.equal(typeof request === "object" ? request.followUp : null, "section-loop-details");
assert.match(typeof request === "object" ? request.message : "", /Which part should I loop/);

assert.equal(
  buildLoopFollowUpCommand("from one minute twenty seconds to one minute thirty seconds"),
  "loop from one minute twenty seconds to one minute thirty seconds"
);
assert.equal(buildLoopFollowUpCommand("1:20 to 1:35"), "loop from 1:20 to 1:35");
assert.equal(
  buildLoopFollowUpCommand("the lyrics are Raghupati Raghav Raja Ram"),
  "loop the part starting with Raghupati Raghav Raja Ram"
);
assert.equal(buildLoopFollowUpCommand("Hey Monday, words starting with Green light"), "loop the part starting with Green light");
assert.equal(isLoopFollowUpCancellation("never mind"), true);
assert.equal(isLoopFollowUpCancellation("Raghupati Raghav"), false);

console.log("PASS: spoken loop clarification, lyric answers, time ranges, wake stripping, and cancellation");
