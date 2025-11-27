const fs = require('fs');

const MARKER = '<!-- ai-pr-reviewer -->';
const GITHUB_API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';

function getInput(name, { required = false } = {}) {
  const key = `INPUT_${name.toUpperCase().replace(/ /g, '_')}`;
  const value = process.env[key];
  if ((value === undefined || value.trim() === '') && required) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value ? value.trim() : '';
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set. This action must run on GitHub Actions.');
  }
  const raw = fs.readFileSync(eventPath, 'utf8');
  return JSON.parse(raw);
}

function buildGitHubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'ai-pr-reviewer',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function githubRequest(url, token, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: buildGitHubHeaders(token, headers),
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function fetchPullRequestDiff(owner, repo, pullNumber, token) {
  let page = 1;
  const patches = [];

  while (true) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`;
    const files = await githubRequest(url, token);

    if (!Array.isArray(files) || files.length === 0) {
      break;
    }

    for (const file of files) {
      if (file && typeof file.patch === 'string') {
        patches.push(file.patch);
      }
    }

    if (files.length < 100) {
      break;
    }
    page += 1;
  }

  return patches.join('\n\n');
}

function ensurePromptTemplate(template) {
  if (!template.includes('{{DIFF}}')) {
    throw new Error('prompt_template must include {{DIFF}} placeholder.');
  }
}

function buildCommentBody(model, message) {
  return [
    MARKER,
    `AI Code Review (model: ${model})`,
    'Найденные проблемы:',
    message,
    'Обновлено автоматически после последнего push.',
  ].join('\n');
}

async function findExistingComment(owner, repo, issueNumber, token) {
  let page = 1;
  while (true) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
    const comments = await githubRequest(url, token);
    if (!Array.isArray(comments) || comments.length === 0) {
      break;
    }

    const match = comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(MARKER));
    if (match) {
      return match;
    }

    if (comments.length < 100) {
      break;
    }
    page += 1;
  }

  return null;
}

async function createOrUpdateComment(owner, repo, issueNumber, token, body, existingId) {
  if (existingId) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/comments/${existingId}`;
    return githubRequest(url, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  return githubRequest(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function callOpenRouter(apiKey, model, prompt) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Title': process.env.GITHUB_REPOSITORY || 'ai-pr-reviewer',
  };

  const referer = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : null;
  if (referer) {
    headers['HTTP-Referer'] = referer;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  console.log(`OpenRouter responded with status: ${response.status}`);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter response missing message content.');
  }

  return String(content).trim();
}

function replaceDiff(template, diff) {
  return template.split('{{DIFF}}').join(diff);
}

async function main() {
  const openrouterApiKey = getInput('openrouter_api_key', { required: true });
  const model = getInput('model', { required: true });
  const promptTemplate = getInput('prompt_template', { required: true });
  const githubToken = process.env.GITHUB_TOKEN;

  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required to call GitHub API.');
  }

  ensurePromptTemplate(promptTemplate);

  const payload = readEventPayload();
  if (!payload.pull_request) {
    console.log('Event is not pull_request; exiting.');
    return;
  }

  const repository = process.env.GITHUB_REPOSITORY || payload.repository?.full_name;
  if (!repository) {
    throw new Error('Repository information missing.');
  }
  const [owner, repo] = repository.split('/');
  const pullNumber = payload.pull_request.number;

  const baseSha = payload.pull_request.base?.sha;
  const headSha = payload.pull_request.head?.sha;
  console.log(`Starting AI review for PR #${pullNumber} (${baseSha} -> ${headSha})`);
  console.log(`Using model: ${model}`);

  const diff = await fetchPullRequestDiff(owner, repo, pullNumber, githubToken);
  console.log(`Diff size (chars): ${diff.length}`);

  let reviewText = '';
  let statusNote = '';

  if (!diff) {
    reviewText = 'Diff пуст';
    statusNote = 'No diff content; posting empty diff notice.';
  } else {
    const prompt = replaceDiff(promptTemplate, diff);
    try {
      reviewText = await callOpenRouter(openrouterApiKey, model, prompt);
      statusNote = 'OpenRouter request succeeded.';
    } catch (error) {
      console.error('OpenRouter request failed:', error.message);
      reviewText = `Не удалось получить ответ от OpenRouter: ${error.message}`;
      statusNote = 'Posting error message instead of analysis.';
    }
  }

  const body = buildCommentBody(model, reviewText);
  const existing = await findExistingComment(owner, repo, pullNumber, githubToken);

  const result = await createOrUpdateComment(
    owner,
    repo,
    pullNumber,
    githubToken,
    body,
    existing?.id,
  );

  const commentId = result?.id || existing?.id;
  console.log(statusNote);
  console.log(`Comment ${existing ? 'updated' : 'created'} with ID: ${commentId}`);
}

main().catch((error) => {
  console.error('Action failed:', error.message);
  process.exitCode = 1;
});
