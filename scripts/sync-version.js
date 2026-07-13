const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');

function makePatchRequest(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      method: 'PATCH',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: data
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
}

async function syncVersion() {
  try {
    // 1. Read version from web/package.json
    const webPackageJsonPath = path.join(__dirname, '..', 'web', 'package.json');
    if (!fs.existsSync(webPackageJsonPath)) {
      throw new Error(`web/package.json not found at: ${webPackageJsonPath}`);
    }
    const webPackageData = JSON.parse(fs.readFileSync(webPackageJsonPath, 'utf8'));
    const version = webPackageData.version;
    if (!version) {
      throw new Error('Version field is missing in web/package.json');
    }
    console.log(`Read version '${version}' from web/package.json`);

    // 2. Read access token from configstore
    const homeDir = os.homedir();
    const configPath = path.join(homeDir, '.config', 'configstore', 'firebase-tools.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Firebase tools config not found at: ${configPath}`);
    }
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const accessToken = configData.tokens?.access_token;
    if (!accessToken) {
      throw new Error('OAuth access_token not found in firebase-tools.json');
    }

    // 3. Send PATCH request to Firestore REST API
    const url = 'https://firestore.googleapis.com/v1/projects/gh-tvvc/databases/default/documents/admin/config?updateMask.fieldPaths=minClientVersion';
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
    const body = {
      fields: {
        minClientVersion: {
          stringValue: version
        }
      }
    };

    console.log(`Sending PATCH request to update minClientVersion in Firestore default database to '${version}'...`);
    const response = await makePatchRequest(url, headers, body);

    if (!response.ok) {
      throw new Error(`Firestore REST API returned ${response.status}: ${response.body}`);
    }

    console.log('Successfully synchronized minimum client version in Firestore.');
  } catch (error) {
    console.error('Error synchronizing version:', error);
    process.exit(1);
  }
}

syncVersion();
