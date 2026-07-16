const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 1. Read CallScreen.tsx and extract adjustSdp function
const filePath = path.resolve(__dirname, '../web/src/components/CallScreen.tsx');
const content = fs.readFileSync(filePath, 'utf8');

// Find start of adjustSdp function
const startMatch = content.match(/const adjustSdp = \([\s\S]*?\)\s*(:\s*\w+)?\s*=>\s*\{/);
if (!startMatch) {
  console.error("FAIL: Could not find start of adjustSdp function in CallScreen.tsx");
  process.exit(1);
}
const startIndex = startMatch.index;

// Extract function block by matching curly braces
const braceStartIndex = startIndex + startMatch[0].length - 1;
let openBraces = 1;
let endIndex = braceStartIndex + 1;
while (openBraces > 0 && endIndex < content.length) {
  const char = content[endIndex];
  if (char === '{') openBraces++;
  else if (char === '}') openBraces--;
  endIndex++;
}

const rawFunctionCode = content.substring(startIndex, endIndex);

// Strip TypeScript type annotations to make it valid JavaScript for Node.js
const cleanFunctionCode = rawFunctionCode
  .replace(/\(sdp:\s*string\)(:\s*string)?\s*=>/, '(sdp) =>')
  .replace(/\(sdp:\s*string\)\s*=>/, '(sdp) =>')
  .replace(/:\s*string\s*\|\s*null/g, '')
  .replace(/:\s*\{\s*\[\s*key:\s*string\s*\]:\s*string\s*\}/g, '')
  .replace(/:\s*string\[\]/g, '');

console.log("-----------------------------------------");
console.log("Extracted adjustSdp function (Transpiled):");
console.log(cleanFunctionCode);
console.log("-----------------------------------------\n");

// Compile and load the function into the current context
let adjustSdp;
try {
  adjustSdp = vm.runInNewContext(cleanFunctionCode + "\n\nadjustSdp;");
} catch (err) {
  console.error("FAIL: Failed to compile extracted adjustSdp function:", err);
  process.exit(1);
}

// 2. Define Test Cases
const testCases = [
  {
    name: "Happy Path: Standard SDP with Opus containing useinbandfec=1",
    input: [
      "v=0",
      "o=- 831278381831 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
      "c=IN IP4 0.0.0.0",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 useinbandfec=1",
      "a=rtpmap:63 red/48000/2",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=rtpmap:96 VP8/90000"
    ].join('\r\n'),
    assert: (output) => {
      const lines = output.split('\r\n');
      
      // Check line endings
      if (!output.includes('\r\n') || output.includes('\n\n')) {
        return "Failed line endings check: should use \\r\\n exclusively.";
      }

      // Check Opus mono parameter replacement
      const fmtpLine = lines.find(l => l.includes('a=fmtp:111'));
      if (!fmtpLine) return "Could not find a=fmtp:111 line.";
      const expectedParams = "useinbandfec=1;stereo=0;sprop-stereo=0;ptime=10;minptime=10;maxaveragebitrate=20000";
      if (!fmtpLine.includes(expectedParams)) {
        return `fmtp line did not contain correct Opus parameters. Got: ${fmtpLine}`;
      }

      // Check separate a=ptime:10 inside audio section
      const audioIdx = lines.findIndex(l => l.startsWith('m=audio'));
      if (audioIdx === -1) return "Could not find m=audio line.";
      const videoIdx = lines.findIndex(l => l.startsWith('m=video'));
      const audioSection = lines.slice(audioIdx + 1, videoIdx === -1 ? lines.length : videoIdx);
      if (!audioSection.includes("a=ptime:10")) {
        return "Expected a=ptime:10 in audio section.";
      }

      // Verify no other ptime is in audio section
      const ptimeLines = audioSection.filter(l => l.startsWith('a=ptime:'));
      if (ptimeLines.length !== 1) {
        return `Expected exactly one a=ptime line in audio section. Got: ${ptimeLines.join(', ')}`;
      }

      return null; // Pass
    }
  },
  {
    name: "Existing ptime: Replacement and no duplication",
    input: [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 useinbandfec=1",
      "a=ptime:20",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=ptime:30"
    ].join('\r\n'),
    assert: (output) => {
      const lines = output.split('\r\n');
      const audioIdx = lines.findIndex(l => l.startsWith('m=audio'));
      const videoIdx = lines.findIndex(l => l.startsWith('m=video'));

      // Check ptime in audio section
      const audioSection = lines.slice(audioIdx + 1, videoIdx);
      const ptimeAudio = audioSection.filter(l => l.startsWith('a=ptime:'));
      if (ptimeAudio.length !== 1 || ptimeAudio[0] !== "a=ptime:10") {
        return `Expected exactly a=ptime:10 in audio section. Got: ${ptimeAudio.join(', ')}`;
      }

      // Check ptime in video section (should be preserved)
      const videoSection = lines.slice(videoIdx + 1);
      const ptimeVideo = videoSection.filter(l => l.startsWith('a=ptime:'));
      if (ptimeVideo.length !== 1 || ptimeVideo[0] !== "a=ptime:30") {
        return `Expected video ptime to remain unchanged (a=ptime:30). Got: ${ptimeVideo.join(', ')}`;
      }

      return null;
    }
  },
  {
    name: "Multiple m=audio lines: Handling multi-stream SDP",
    input: [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 useinbandfec=1",
      "m=audio 9 UDP/TLS/RTP/SAVPF 112",
      "a=rtpmap:112 opus/48000/2",
      "a=fmtp:112 useinbandfec=1"
    ].join('\r\n'),
    assert: (output) => {
      const lines = output.split('\r\n');
      const audioIndices = lines.map((l, i) => l.startsWith('m=audio') ? i : -1).filter(i => i !== -1);
      
      if (audioIndices.length !== 2) {
        return `Expected 2 audio sections. Got: ${audioIndices.length}`;
      }

      for (let i = 0; i < audioIndices.length; i++) {
        const startIdx = audioIndices[i];
        const endIdx = i + 1 < audioIndices.length ? audioIndices[i + 1] : lines.length;
        const section = lines.slice(startIdx + 1, endIdx);
        if (!section.includes("a=ptime:10")) {
          return `Audio section ${i + 1} did not contain a=ptime:10.`;
        }
      }

      return null;
    }
  },
  {
    name: "Idempotency: Running adjustSdp twice on the same SDP",
    input: null, // set dynamically from output of test 1
    assert: (output, firstOutput) => {
      const secondOutput = adjustSdp(firstOutput);
      
      const firstLines = firstOutput.split('\r\n');
      const secondLines = secondOutput.split('\r\n');

      // Check if second output is identical to first output
      if (secondOutput !== firstOutput) {
        // Find differences
        const firstFmtp = firstLines.find(l => l.includes('a=fmtp:111'));
        const secondFmtp = secondLines.find(l => l.includes('a=fmtp:111'));
        if (firstFmtp !== secondFmtp) {
          return `NON-IDEMPOTENT: a=fmtp:111 line changed on second run.\nFirst:  ${firstFmtp}\nSecond: ${secondFmtp}`;
        }
        return `NON-IDEMPOTENT: Output changed on second run, though fmtp matched.`;
      }
      return null;
    }
  },
  {
    name: "Missing useinbandfec=1: Checking fallback behavior",
    input: [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 stereo=1", // no useinbandfec=1
    ].join('\r\n'),
    assert: (output) => {
      const lines = output.split('\r\n');
      const fmtpLine = lines.find(l => l.includes('a=fmtp:111'));
      if (!fmtpLine) return "Could not find a=fmtp:111 line.";
      
      // Check if Opus low-latency parameters were injected
      if (!fmtpLine.includes("stereo=0") || !fmtpLine.includes("ptime=10")) {
        return `WARNING/FAIL: SDP did not get low-latency parameters because 'useinbandfec=1' was missing from input. Got: ${fmtpLine}`;
      }
      return null;
    }
  },
  {
    name: "Prefix safety: Opus PT=11 and other PT=111",
    input: [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 11 111",
      "a=rtpmap:11 opus/48000/2",
      "a=fmtp:11 useinbandfec=1",
      "a=rtpmap:111 red/48000/2",
      "a=fmtp:111 stereo=1"
    ].join('\r\n'),
    assert: (output) => {
      const lines = output.split('\r\n');
      
      // Verify a=fmtp:11 is modified to include our target parameters
      const fmtp11 = lines.find(l => l.startsWith('a=fmtp:11 '));
      if (!fmtp11) return "Could not find a=fmtp:11 line.";
      const expectedParams = "useinbandfec=1;stereo=0;sprop-stereo=0;ptime=10;minptime=10;maxaveragebitrate=20000";
      if (!fmtp11.includes(expectedParams)) {
        return `a=fmtp:11 did not contain expected low-latency parameters. Got: ${fmtp11}`;
      }

      // Verify a=fmtp:111 is NOT modified to a=fmtp:11 or corrupted
      const fmtp111 = lines.find(l => l.startsWith('a=fmtp:111'));
      if (!fmtp111) return "Could not find a=fmtp:111 line.";
      if (fmtp111 !== "a=fmtp:111 stereo=1") {
        return `a=fmtp:111 was modified or corrupted! Got: ${fmtp111}`;
      }

      return null;
    }
  }
];

// 3. Run Tests
let allPassed = true;
console.log("Running adjustSdp Verification Tests...");

// We will save happy path output for the idempotency test
let happyPathOutput = "";

for (const tc of testCases) {
  console.log(`\nTest Case: ${tc.name}`);
  let input = tc.input;
  if (tc.name === "Idempotency: Running adjustSdp twice on the same SDP") {
    input = happyPathOutput;
  }

  try {
    const output = adjustSdp(input);
    if (tc.name === "Happy Path: Standard SDP with Opus containing useinbandfec=1") {
      happyPathOutput = output;
    }

    const err = tc.assert(output, happyPathOutput);
    if (err) {
      console.log(`❌ FAIL: ${err}`);
      allPassed = false;
    } else {
      console.log("✅ PASS");
    }
  } catch (err) {
    console.log(`❌ ERROR (Exception thrown): ${err.message}`);
    console.log(err.stack);
    allPassed = false;
  }
}

console.log("\n-----------------------------------------");
if (allPassed) {
  console.log("ALL TESTS COMPLETED (Some might have failed/warned as expected).");
  process.exit(0);
} else {
  console.log("SOME TESTS FAILED.");
  process.exit(1);
}
