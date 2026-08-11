import axios from 'axios';
import { ImapFlow } from 'imapflow';
import logger from './logger.js';

/** Thunderbird 公共应用 Client ID，无需 client_secret */
export const OUTLOOK_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
export const OUTLOOK_REDIRECT_URI = 'https://localhost';
export const OUTLOOK_SCOPES = [
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'https://outlook.office.com/SMTP.Send',
    'offline_access'
].join(' ');

export interface OutlookCredentials {
    email: string;
    clientId: string;
    refreshToken: string;
}

function maskEmail(email: string): string {
    const [name, domain = ''] = email.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
}

function safeMessage(value: unknown, credentials: OutlookCredentials): string {
    const message = String(value ?? 'unknown').replace(credentials.refreshToken, '[REDACTED]');
    return message.replaceAll(credentials.email, maskEmail(credentials.email)).slice(0, 500);
}

function preflightError(
    credentials: OutlookCredentials,
    stage: string,
    category: string,
    error: any,
    retryable: boolean,
    action: string
): Error {
    const details = {
        email: maskEmail(credentials.email),
        stage,
        category,
        status: error?.response?.status ?? error?.responseStatus ?? error?.statusCode ?? error?.code ?? null,
        serverError: error?.response?.data?.error ?? error?.serverResponseCode ?? error?.code ?? null,
        message: safeMessage(error?.response?.data?.error_description ?? error?.message ?? error, credentials),
        retryable,
        action
    };
    return new Error(`OUTLOOK_PREFLIGHT ${JSON.stringify(details)}`);
}

function classifyNetworkError(error: any): { category: string; retryable: boolean; action: string } {
    const code = String(error?.code ?? '').toUpperCase();
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code))
        return { category: 'dns_error', retryable: true, action: '检查 DNS 和网络后重试' };
    if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code))
        return { category: 'network_timeout', retryable: true, action: '检查网络连通性后重试' };
    if (/TLS|CERT|SSL/.test(code))
        return { category: 'tls_error', retryable: false, action: '检查系统时间、证书和 TLS 代理配置' };
    return { category: 'network_error', retryable: true, action: '检查网络和 Outlook 服务状态后重试' };
}

export function buildAuthorizeUrl(loginHint?: string): string {
    const params = new URLSearchParams({
        client_id: OUTLOOK_CLIENT_ID,
        response_type: 'code',
        redirect_uri: OUTLOOK_REDIRECT_URI,
        scope: OUTLOOK_SCOPES,
        response_mode: 'query',
        prompt: 'select_account'
    });
    if (loginHint)
        params.set('login_hint', loginHint);
    return `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?${params}`;
}

export async function exchangeAuthorizationCode(code: string): Promise<{ accessToken: string; refreshToken: string }> {
    const body = new URLSearchParams({
        client_id: OUTLOOK_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: OUTLOOK_REDIRECT_URI,
        scope: OUTLOOK_SCOPES
    });
    const { data } = await axios.post(
        'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
        body,
        { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
    );
    if (!data.access_token || !data.refresh_token)
        throw new Error(`授权码换取 token 失败：${data.error_description ?? data.error ?? '缺少 access_token/refresh_token'}`);
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

async function getAccessToken(credentials: OutlookCredentials): Promise<string> {
    const body = new URLSearchParams({
        client_id: credentials.clientId,
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        scope: OUTLOOK_SCOPES
    });

    try {
        const { data } = await axios.post(
            'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
            body,
            { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
        );

        if (!data.access_token)
            throw new Error(`响应中没有 access_token: ${data.error ?? 'unknown_error'}`);
        return data.access_token;
    }
    catch (error) {
        if (axios.isAxiosError(error)) {
            const code = error.response?.data?.error ?? error.code ?? 'request_failed';
            const description = String(error.response?.data?.error_description ?? error.message);
            if (code === 'invalid_grant') {
                const expired = /expired|sign in again|重新登录/i.test(description);
                throw preflightError(credentials, 'oauth_token_exchange', 'invalid_grant', error, false,
                    expired ? 'refresh token 已失效，请重新授权 Outlook' : '请重新授权 Outlook 并更新 refresh token');
            }
            if (code === 'invalid_client')
                throw preflightError(credentials, 'oauth_token_exchange', 'invalid_client', error, false, '确认 client_id 与 refresh token 来自同一应用');
            const network = classifyNetworkError(error);
            throw preflightError(credentials, 'oauth_token_exchange', error.response ? 'oauth_token_error' : network.category,
                error,
                error.response ? error.response.status >= 500 : network.retryable,
                error.response ? '检查 Microsoft OAuth 响应及应用授权配置' : network.action);
        }
        throw error;
    }
}

function createClient(credentials: OutlookCredentials, accessToken: string): ImapFlow {
    return new ImapFlow({
        host: 'outlook.live.com',
        port: 993,
        secure: true,
        auth: { user: credentials.email, accessToken },
        logger: false
    });
}

function classifyImapError(credentials: OutlookCredentials, stage: string, error: any): Error {
    const message = String(error?.message ?? error);
    const response = `${error?.responseText ?? ''} ${message}`;
    const responseStatus = String(error?.responseStatus ?? '').toUpperCase();
    if (/AUTHENTICATIONFAILED|authentication failed|login failed/i.test(response)
        || (stage === 'imap_connect' && responseStatus === 'NO'))
        return preflightError(credentials, stage, 'imap_authentication_failed', error, false, '确认 token 包含 IMAP.AccessAsUser.All 权限且邮箱允许 IMAP');
    if (/permission|not permitted|denied|authorization/i.test(response))
        return preflightError(credentials, stage, 'imap_permission_denied', error, false, '为应用授予 IMAP.AccessAsUser.All 权限后重新授权');
    if (/mailbox|folder|NONEXISTENT/i.test(response))
        return preflightError(credentials, stage, 'imap_mailbox_unavailable', error, false, '确认 Outlook 收件箱可访问');
    const network = classifyNetworkError(error);
    return preflightError(credentials, stage, network.category, error, network.retryable, network.action);
}

/** 用 OAuth2 access token 连接 IMAP 并读取收件箱，作为注册成功标准 */
export async function preflightOutlook(credentials: OutlookCredentials): Promise<void> {
    if (!/^\S+@\S+\.\S+$/.test(credentials.email) || !credentials.clientId.trim() || !credentials.refreshToken.trim())
        throw preflightError(credentials, 'input_validation', 'invalid_input', new Error('邮箱、client_id 或 refresh_token 格式无效'), false, '修正账号输入格式');

    const accessToken = await getAccessToken(credentials);
    const client = createClient(credentials, accessToken);
    try {
        try {
            await client.connect();
        }
        catch (error) {
            throw classifyImapError(credentials, 'imap_connect', error);
        }

        try {
            const mailboxes = await client.list();
            const inbox = mailboxes.find(box => box.specialUse === '\\Inbox' || /^inbox$/i.test(box.path));
            if (!inbox)
                throw new Error('Inbox mailbox was not listed');
            const lock = await client.getMailboxLock(inbox.path);
            try {
                await client.search({ all: true });
            }
            finally {
                lock.release();
            }
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith('OUTLOOK_PREFLIGHT '))
                throw error;
            throw classifyImapError(credentials, 'imap_mailbox_read', error);
        }
    }
    finally {
        await client.logout().catch(() => undefined);
    }
    logger.info('Outlook OAuth2/IMAP 预检成功：%s', maskEmail(credentials.email));
}
