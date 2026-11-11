window.__ModuleLoader__.load({
  id: '@forst/dsh-web-search-tavily',
  factory: require => {
    const React = require('react');
    const { SettingsSecretField } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const tavily = 'forst-tavily';
    const providers = {
      'deepseek-official': {
        label: 'DeepSeek Messages', scope: 'web-search-deepseek',
        urlLabel: 'Messages API 基础地址', url: 'https://api.deepseek.com/anthropic/v1',
        limit: 'maxUses', limitLabel: '单次请求最多搜索次数', defaultLimit: 5,
      },
      'deepseek-search-api': {
        label: 'DeepSeek Search API', scope: 'web-deepseek-api',
        urlLabel: 'Search / Fetch API 基础地址', url: 'https://api.deepseek.com/v1/tools',
        limit: 'count', limitLabel: '每次搜索结果数', defaultLimit: 10, maxLimit: 50,
      },
      [tavily]: { label: 'Tavily' },
    };
    const control = {
      border: '1px solid var(--dsw-alias-border-l2, #aaa)',
      borderRadius: 'var(--dsw-radius-sm, 6px)', padding: '8px 10px',
    };
    const group = { display: 'grid', gap: '8px' };
    const searchPage = '[data-plugin-item-detail="web-search"]:has([data-forst-web-search])';
    const bundlePage = '[data-plugin-detail="@forst/dsh-toolkit-local"]';
    const componentNames = {
      'forst-opencode-go-quota': 'OpenCode Go 月额度',
      'forst-session-billing': '会话费用',
      'forst-web-search-tavily': '网页搜索',
    };

    function useForm(form) {
      const [subscribe, snapshot] = React.useMemo(
        () => [form.subscribe.bind(form), form.getSnapshot.bind(form)], [form],
      );
      return React.useSyncExternalStore(subscribe, snapshot);
    }

    function fieldOp(snapshot, field, value) {
      return value === undefined || value === snapshot.base?.[field]
        ? { op: 'unset', path: [field] }
        : { op: 'set', path: [field], value };
    }

    function ProviderEditor({ id, web, webForm, settings, settingsForm, credentials, busy, setBusy, fetchApiAvailable, onSaved }) {
      const provider = providers[id];
      const ref = id === tavily ? 'TAVILY_API_KEY' : settings?.value?.apiKeyEnv || 'DEEPSEEK_API_KEY';
      const [apiKey, setApiKey] = React.useState('');
      const [credential, setCredential] = React.useState(null);
      const [draft, setDraft] = React.useState({});
      const [fetchDraft, setFetchDraft] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const currentFetch = web.value?.fetchProvider ?? 'http';
      const selectedFetch = fetchDraft ?? currentFetch;
      const configured = credential?.ref === ref && credential.configured;
      const currentSearch = web.value?.searchProvider ?? 'deepseek-official';
      const writeable = web.writable && (!provider.scope || settings?.writable);
      const keyText = apiKey.trim();
      const missingKey = id === tavily && !keyText && !configured;
      const hasEdits = currentSearch !== id || currentFetch !== selectedFetch || Object.keys(draft).length > 0 || keyText !== '';

      React.useEffect(() => {
        let mounted = true;
        async function describe() {
          try {
            const result = await credentials.describe([ref]);
            if (!result.ok) throw new Error();
            if (mounted) setCredential({ ref, ...result.value[ref] });
          } catch {
            if (mounted) setNotice('暂时无法读取密钥状态。');
          }
        }
        void describe();
        return () => { mounted = false; };
      }, [credentials, ref]);

      async function save(event) {
        event.preventDefault();
        if (busy || !writeable || missingKey || !hasEdits) return;
        const configOps = [];
        if (Object.hasOwn(draft, 'baseURL')) {
          const text = draft.baseURL.trim();
          const url = text ? URL.parse(text) : null;
          if (text && (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)) {
            setNotice('请填写有效的 HTTP 或 HTTPS 基础地址。');
            return;
          }
          configOps.push(fieldOp(settings, 'baseURL', text || undefined));
        }
        if (provider.limit && Object.hasOwn(draft, provider.limit)) {
          const text = draft[provider.limit].trim();
          const value = text ? Number(text) : undefined;
          if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > (provider.maxLimit ?? Infinity))) {
            setNotice(provider.maxLimit ? '请输入 1–50 的整数。' : '请输入大于 0 的整数。');
            return;
          }
          configOps.push(fieldOp(settings, provider.limit, value));
        }
        const webOps = [];
        if (currentSearch !== id) webOps.push(fieldOp(web, 'searchProvider', id));
        if (currentFetch !== selectedFetch) webOps.push(fieldOp(web, 'fetchProvider', selectedFetch));
        setBusy(true);
        try {
          if (keyText) {
            const result = await credentials.set(ref, keyText);
            if (!result.ok) {
              setNotice('无法保存 API Key。');
              return;
            }
            setApiKey('');
            setCredential({ ref, configured: true, writable: true });
          }
          if (configOps.length) {
            if (!await settingsForm.mutate(configOps, settings.revision)) {
              setNotice('无法保存供应商参数，请重试。');
              return;
            }
            setDraft({});
          }
          if (webOps.length && !await webForm.mutate(webOps, web.revision)) {
            setNotice('无法保存搜索或抓取供应商，请重试。');
            return;
          }
          setFetchDraft(null);
          setNotice('已保存。');
          onSaved();
        } catch {
          setNotice('保存未完成，请重试。');
        } finally {
          setBusy(false);
        }
      }

      function valueField(field, label, fallback, props = {}) {
        const staged = Object.hasOwn(draft, field);
        const inherited = settings?.value?.[field] ?? fallback;
        return h('div', { style: group },
          h('label', { htmlFor: `forst-search-${field}` }, label),
          h('input', {
            id: `forst-search-${field}`, value: staged ? draft[field] : String(inherited),
            placeholder: String(fallback), style: control, disabled: busy || !writeable,
            onChange: event => setDraft(previous => ({ ...previous, [field]: event.target.value })),
            ...props,
          }),
          Object.hasOwn(settings?.user ?? {}, field) || staged
            ? h('button', { type: 'button', disabled: busy || !writeable, style: { justifySelf: 'end' },
              onClick: () => setDraft(previous => ({ ...previous, [field]: '' })) }, '恢复默认')
            : null);
      }

      return h('form', { onSubmit: save, style: { ...group, gap: '18px' } },
        h(SettingsSecretField, {
          id: 'forst-search-key', label: id === tavily ? 'Tavily API Key' : 'API Key',
          text: apiKey, configured, disabled: busy || !writeable || credential?.writable === false,
          hint: '留空保留现有密钥。',
          stateLabel: configured ? '已配置密钥' : id === tavily ? '请配置 Tavily API Key' : '未配置密钥',
          onEdit: setApiKey,
        }),
        provider.scope ? valueField('baseURL', provider.urlLabel, provider.url) : h('p', null, '搜索端点：', h('code', null, 'https://api.tavily.com/search')),
        provider.limit ? valueField(provider.limit, provider.limitLabel, provider.defaultLimit, {
          type: 'number', min: 1, max: provider.maxLimit, step: 1,
        }) : null,
        h('label', { style: group }, '网页抓取',
          h('select', { value: selectedFetch, onChange: event => setFetchDraft(event.target.value), disabled: busy || !writeable, style: control },
            !['http', 'deepseek-fetch-api'].includes(currentFetch) ? h('option', { value: currentFetch }, currentFetch) : null,
            h('option', { value: 'http' }, '本地 HTTP'),
            h('option', { value: 'deepseek-fetch-api', disabled: !fetchApiAvailable }, 'DeepSeek Fetch API'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', { type: 'submit', disabled: busy || !writeable || !hasEdits || missingKey, style: control }, busy ? '保存中…' : '保存'),
          h('span', { role: 'status' }, notice)));
    }

    function SettingsPage({ subject, forms, credentials }) {
      if (subject.kind !== 'item' || subject.id !== 'web-search') return null;
      return h(ProviderPicker, { forms, credentials });
    }

    function ProviderPicker({ forms, credentials }) {
      const web = useForm(forms.web);
      const messages = useForm(forms['web-search-deepseek']);
      const searchApi = useForm(forms['web-deepseek-api']);
      const scopes = { 'web-search-deepseek': messages, 'web-deepseek-api': searchApi };
      const [selection, setSelection] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const current = web.value?.searchProvider ?? 'deepseek-official';
      const id = selection ?? current;
      const provider = Object.hasOwn(providers, id) ? providers[id] : undefined;
      return h('section', { 'data-forst-web-search': '', style: { ...group, gap: '18px' } },
        h('label', { style: group }, '搜索供应商',
          h('select', {
            value: id, style: control, disabled: busy || web.status !== 'ready' || !web.writable,
            onChange: event => setSelection(event.target.value),
          },
          !Object.hasOwn(providers, current) ? h('option', { value: current }, current) : null,
          Object.entries(providers).map(([key, option]) => h('option', {
            key, value: key, disabled: option.scope && scopes[option.scope].status !== 'ready',
          }, option.label)))),
        provider ? h(ProviderEditor, {
          key: id, id, web, webForm: forms.web,
          settings: scopes[provider.scope], settingsForm: forms[provider.scope], credentials,
          busy, setBusy, fetchApiAvailable: searchApi.status === 'ready',
          onSaved: () => setSelection(null),
        }) : null);
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.credentials'],
      apply(ctx) {
        const names = ['web', 'web-search-deepseek', 'web-deepseek-api'];
        ctx.effect(() => {
          const style = document.createElement('style');
          // 组件卸载后，DSH 自带的 DeepSeek 设置会重新显示。
          const labels = Object.entries(componentNames).map(([id, label]) =>
            `${bundlePage} [data-plugin-row$="${id}"] { --forst-component-name: ${JSON.stringify(label)}; }`,
          );
          style.textContent = [
            `${searchPage} [data-plugin-config], ${searchPage} p[class$="_detailDesc"] { display: none; }`,
            ...labels,
            // 文件入口允许每个组件独立加载。详情页只显示简短名称。
            `${bundlePage} [data-plugin-row] [class$="_rowMain"]::before { content: var(--forst-component-name); font-weight: 500; }`,
            `${bundlePage} [data-plugin-row] [class$="_rowMain"] > :is([class$="_rowId"], code[class$="_rowModule"]) { display: none; }`,
          ].join('\n');
          document.head.appendChild(style);
          return () => style.remove();
        });
        ctx.effect(() => ctx.configForms.whileServed(['web'], () => ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section', id: 'forst-web-search-settings',
          inject: () => ({
            forms: Object.fromEntries(names.map(name => [name, ctx.configForms.get(name)])),
            credentials: ctx.remote.credentials,
          }),
        }, SettingsPage))), '网页搜索设置');
      },
    };
  },
});
