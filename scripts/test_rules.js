const http = require('http');

const PORT = 8080;
const PROJECT_ID = 'gh-tvvc';
const DATABASE_ID = '(default)';
const BASE_URL = `http://localhost:${PORT}/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;

const makeJwt = (uid) => {
  const header = { alg: "none", typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: uid,
    user_id: uid,
    uid: uid
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64(header)}.${b64(payload)}.`;
};

const getHeaders = (uid) => {
  const headers = { 'Content-Type': 'application/json' };
  if (uid) {
    headers['Authorization'] = `Bearer ${makeJwt(uid)}`;
  }
  return headers;
};

// Helper to make a fetch-like request using node's built-in http module
const request = (method, path, uid, body = null) => {
  return new Promise((resolve, reject) => {
    const urlStr = `${BASE_URL}${path}`;
    const url = new URL(urlStr);
    const options = {
      method: method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: getHeaders(uid)
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data: data ? JSON.parse(data) : null
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
};

const runTests = async () => {
  console.log("Starting security rules validation tests...");
  let pass = true;

  const runScenario = async (name, action) => {
    try {
      const result = await action();
      if (result) {
        console.log(`[PASS] ${name}`);
      } else {
        console.log(`[FAIL] ${name}`);
        pass = false;
      }
    } catch (err) {
      console.log(`[ERROR] ${name}:`, err.message);
      pass = false;
    }
  };

  // Scenario 1 (Positive F-01): User A can read/write calls candidate documents when callId is "userA_userB".
  await runScenario("Scenario 1 (Positive F-01): User A can write call candidate", async () => {
    const resWrite = await request('PATCH', '/calls/userA_userB/callerCandidates/cand1', 'userA', {
      fields: { candidate: { stringValue: 'ice-candidate-data' } }
    });
    const resRead = await request('GET', '/calls/userA_userB/callerCandidates/cand1', 'userA');
    return resWrite.status === 200 && resRead.status === 200;
  });

  // Scenario 2 (Positive F-01): User B can read/write calls candidate documents when callId is "userA_userB".
  await runScenario("Scenario 2 (Positive F-01): User B can write call candidate", async () => {
    const resWrite = await request('PATCH', '/calls/userA_userB/calleeCandidates/cand2', 'userB', {
      fields: { candidate: { stringValue: 'ice-candidate-data-2' } }
    });
    const resRead = await request('GET', '/calls/userA_userB/calleeCandidates/cand2', 'userB');
    return resWrite.status === 200 && resRead.status === 200;
  });

  // Scenario 3 (Negative F-01): User C CANNOT read/write calls candidate documents when callId is "userA_userB".
  await runScenario("Scenario 3 (Negative F-01): User C CANNOT write/read call candidate", async () => {
    const resWrite = await request('PATCH', '/calls/userA_userB/callerCandidates/cand1', 'userC', {
      fields: { candidate: { stringValue: 'malicious' } }
    });
    const resRead = await request('GET', '/calls/userA_userB/callerCandidates/cand1', 'userC');
    // We expect both to be denied (403)
    return resWrite.status === 403 && resRead.status === 403;
  });

  // Scenario 4 (Positive F-05): User A can read/write "users/userA/private/secrets".
  await runScenario("Scenario 4 (Positive F-05): User A can write/read their own private secrets", async () => {
    const resWrite = await request('PATCH', '/users/userA/private/secrets', 'userA', {
      fields: { fcmToken: { stringValue: 'fcm-token-A' } }
    });
    const resRead = await request('GET', '/users/userA/private/secrets', 'userA');
    return resWrite.status === 200 && resRead.status === 200;
  });

  // Scenario 5 (Negative F-05): User B CANNOT read/write "users/userA/private/secrets".
  await runScenario("Scenario 5 (Negative F-05): User B CANNOT write/read User A's private secrets", async () => {
    const resWrite = await request('PATCH', '/users/userA/private/secrets', 'userB', {
      fields: { fcmToken: { stringValue: 'fcm-token-B-hack' } }
    });
    const resRead = await request('GET', '/users/userA/private/secrets', 'userB');
    return resWrite.status === 403 && resRead.status === 403;
  });

  // Scenario 6 (Security check): An authenticated user with UID ".*" cannot bypass rules to read non-owned callId candidate documents if they don't belong to the callId.
  await runScenario("Scenario 6 (Security check): User with UID '.*' CANNOT bypass call candidate rules", async () => {
    // Attempting to read/write call candidates of userA_userB with UID ".*"
    const resWrite = await request('PATCH', '/calls/userA_userB/callerCandidates/cand_exploit', '.*', {
      fields: { candidate: { stringValue: 'exploit' } }
    });
    const resRead = await request('GET', '/calls/userA_userB/callerCandidates/cand1', '.*');
    
    console.log(`  DEBUG: write status for UID ".*": ${resWrite.status}, read status: ${resRead.status}`);
    
    // We expect both to be denied (403) if the rule is secure
    return resWrite.status === 403 && resRead.status === 403;
  });

  // Scenario 7 (Positive F-06): User B can read/write candidates when callId has triple-segment format and userB is callee (matching in middle)
  await runScenario("Scenario 7 (Positive F-06): User B (callee) can access candidates in triple-segment callId", async () => {
    const resWrite = await request('PATCH', '/calls/userA_userB_uuid123/calleeCandidates/cand1', 'userB', {
      fields: { candidate: { stringValue: 'ice-candidate-data' } }
    });
    const resRead = await request('GET', '/calls/userA_userB_uuid123/calleeCandidates/cand1', 'userB');
    return resWrite.status === 200 && resRead.status === 200;
  });

  // Scenario 8 (Positive F-06): User A (caller) can read/write candidates when callId has triple-segment format (matching at start)
  await runScenario("Scenario 8 (Positive F-06): User A (caller) can access candidates in triple-segment callId", async () => {
    const resWrite = await request('PATCH', '/calls/userA_userB_uuid123/callerCandidates/cand1', 'userA', {
      fields: { candidate: { stringValue: 'ice-candidate-data' } }
    });
    const resRead = await request('GET', '/calls/userA_userB_uuid123/callerCandidates/cand1', 'userA');
    return resWrite.status === 200 && resRead.status === 200;
  });

  // Scenario 9 (Negative F-06): User C (third-party) CANNOT read/write candidates when callId has triple-segment format
  await runScenario("Scenario 9 (Negative F-06): User C CANNOT access candidates in triple-segment callId", async () => {
    const resWrite = await request('PATCH', '/calls/userA_userB_uuid123/callerCandidates/cand1', 'userC', {
      fields: { candidate: { stringValue: 'malicious' } }
    });
    const resRead = await request('GET', '/calls/userA_userB_uuid123/callerCandidates/cand1', 'userC');
    return resWrite.status === 403 && resRead.status === 403;
  });

  if (pass) {
    console.log("All validation tests passed successfully!");
    process.exit(0);
  } else {
    console.log("Some validation tests failed!");
    process.exit(1);
  }
};

runTests();
