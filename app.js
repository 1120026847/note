// ============ 环境配置（改这里） ============
const CONFIG = {
  // CloudBase
  ENV_ID: 'molijun-0gtahyghc6271173',  // 例如 'molijun-xxxxxx'
  REGION: 'ap-shanghai',                // 你的环境地域

  // COS
  COS_BUCKET: 'notes-1317231591',       // 你的桶名
  COS_REGION: 'ap-guangzhou',           // 桶的地域，与你 STS 中一致
  STS_URL: 'https://molijun-0gtahyghc6271173-1317231591.ap-shanghai.app.tcloudbase.com/api/sts', // 你已开通的 getCosSTS HTTPS URL

  // 站点
  SITE_ORIGIN: location.origin
};
// =========================================

// CloudBase init（v2）
const app = cloudbase.init({ env: CONFIG.ENV_ID, region: CONFIG.REGION }); // 参考官方：
const auth = app.auth({ persistence: 'local' });
const db = app.database();

// 当前用户
let currentUser = null;

// Quill 实例
let quill = null;
// 当前打开的文章
let currentArticle = null; // { _id, title, type, content, updated_at, folder_id, ... }
// 编辑基线时间（用于冲突检测）
let editBaseUpdatedAt = null;

// PDF.js 实例
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// COS 实例（使用 STS 动态授权）
const cos = new COS({
  // 参考文档：用 getAuthorization 向你自己的 STS 接口取临时密钥，然后调用 putObject 等：
  getAuthorization: function (options, callback) {
    fetch(`${CONFIG.STS_URL}?uid=${currentUser?.uid}`, { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => {
        callback({
          TmpSecretId: data.credentials.tmpSecretId || data.credentials.tmpSecretId || data.credentials?.tmpSecretId,
          TmpSecretKey: data.credentials.tmpSecretKey || data.credentials?.tmpSecretKey,
          SecurityToken: data.credentials.sessionToken || data.credentials?.sessionToken,
          StartTime: data.startTime,
          ExpiredTime: data.expiredTime
        });
      })
      .catch((err) => {
        showToast('获取临时密钥失败');
        console.error(err);
      });
  }
});

// ----------------- 小工具 -----------------
const $ = (sel) => document.querySelector(sel);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
function showToast(msg, ms = 1800) {
  const bar = $('#toast');
  bar.textContent = msg;
  bar.classList.remove('hidden');
  setTimeout(() => bar.classList.add('hidden'), ms);
}
function emailAvatarLetter(email) {
  return (email?.[0] || 'U').toUpperCase();
}
function nowISO() {
  return new Date().toISOString();
}
function throttle(fn, wait) {
  let t = 0, cache;
  return (...args) => {
    const now = Date.now();
    if (now - t > wait) {
      t = now;
      cache = fn(...args);
    }
    return cache;
  };
}

// ----------------- 认证视图切换 -----------------
$('#tab-login').addEventListener('click', () => {
  $('#tab-login').classList.add('bg-gray-900','text-white','border-gray-800');
  $('#tab-register').classList.remove('bg-gray-900','text-white','border-gray-800');
  show($('#login-form')); hide($('#register-form'));
});
$('#tab-register').addEventListener('click', () => {
  $('#tab-register').classList.add('bg-gray-900','text-white','border-gray-800');
  $('#tab-login').classList.remove('bg-gray-900','text-white','border-gray-800');
  show($('#register-form')); hide($('#login-form'));
});

// ----------------- 登录注册 -----------------
// 登录
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  try {
    // v2：用户名/邮箱密码登录（以官方文档为准）：
    await auth.signInWithPassword({ username: email, password });
    await afterAuthReady();
  } catch (err) {
    console.error(err);
    showToast('登录失败：' + (err?.message || ''));
  }
});

// 注册
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#register-email').value.trim();
  const password = $('#register-password').value;
  try {
    // v2：邮箱+密码注册（可触发邮箱验证流程）：
    await auth.signUpWithEmailAndPassword({ email, password });
    showToast('注册成功，请检查邮箱验证后再登录');
    $('#tab-login').click();
  } catch (err) {
    console.error(err);
    showToast('注册失败：' + (err?.message || ''));
  }
});

// 退出
$('#btn-logout').addEventListener('click', async () => {
  await auth.signOut();
  location.reload();
});

// ----------------- 登录态恢复 -----------------
auth.onLoginStateChanged(async (state) => {
  if (state) {
    currentUser = state.user || state; // v2 返回 user
    await afterAuthReady();
  } else {
    // 未登录
    show($('#auth-view')); hide($('#main-app-view'));
  }
});

async function afterAuthReady() {
  currentUser = auth.currentUser;
  if (!currentUser) return;

  // UI 切换
  hide($('#auth-view')); show($('#main-app-view'));
  $('#user-email').textContent = currentUser.email || '';
  $('#user-avatar').textContent = emailAvatarLetter(currentUser.email);

  // 初始化编辑器
  initQuill();

  // 加载文件树
  await reloadFileTree();

  showToast('欢迎回来');
}

// ----------------- 文件树 & 数据 -----------------
async function reloadFileTree() {
  const tree = $('#file-tree');
  tree.innerHTML = '<div class="text-sm text-gray-500 px-2">加载中...</div>';

  // folders
  const { data: folders } = await db.collection('folders')
    .where({ user_id: currentUser.uid })
    .orderBy('created_at', 'asc')
    .get();

  // uncategorized articles
  const { data: articles } = await db.collection('articles')
    .where({ user_id: currentUser.uid })
    .orderBy('updated_at', 'desc')
    .get();

  // 构造 {folderId: [articles]}
  const articlesByFolder = {};
  for (const a of articles) {
    const fid = a.folder_id || '_uncat';
    if (!articlesByFolder[fid]) articlesByFolder[fid] = [];
    articlesByFolder[fid].push(a);
  }

  // 渲染
  let html = '';
  // 未分类
  html += renderFolderBlock({ _id: '_uncat', name: '未分类' }, articlesByFolder['_uncat'] || []);
  // 用户文件夹
  for (const f of folders) {
    html += renderFolderBlock(f, articlesByFolder[f._id] || []);
  }
  tree.innerHTML = html;

  // 绑定点击
  tree.querySelectorAll('[data-article]').forEach((el) => {
    el.addEventListener('click', () => openArticle(el.dataset.article));
  });

  // 右键菜单（简化：用浏览器默认菜单或后续可加自定义）
}

function renderFolderBlock(folder, articles) {
  const folderIcon = `<i data-feather="folder"></i>`;
  const rows = articles.map(a => {
    const icon = a.type === 'pdf' ? '<i data-feather="file-text"></i>' : '<i data-feather="edit-3"></i>';
    return `
      <div class="pl-6 py-1 flex items-center gap-2 hover:bg-gray-50 cursor-pointer" data-article="${a._id}">
        <span class="text-gray-500">${icon}</span>
        <span class="flex-1 truncate">${a.title || '(未命名)'}</span>
        <span class="text-xs text-gray-400">${new Date(a.updated_at).toLocaleDateString()}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="bg-white border rounded">
      <div class="px-3 py-2 font-medium flex items-center gap-2">${folderIcon}<span>${folder.name}</span></div>
      <div>${rows || '<div class="pl-6 py-2 text-sm text-gray-400">暂无文章</div>'}</div>
    </div>
  `;
}

// 新建文件夹
$('#btn-new-folder').addEventListener('click', async () => {
  const name = prompt('文件夹名称：');
  if (!name) return;
  await db.collection('folders').add({
    name, user_id: currentUser.uid, created_at: nowISO()
  });
  await reloadFileTree();
});

// 新建文章（富文本）
$('#btn-new-article').addEventListener('click', async () => {
  const title = prompt('新文章标题：') || '未命名';
  const res = await db.collection('articles').add({
    title, user_id: currentUser.uid, type: 'text', content: '', created_at: nowISO(), updated_at: nowISO()
  });
  await reloadFileTree();
  await openArticle(res.id);
});

// 打开文章
async function openArticle(id) {
  const { data } = await db.collection('articles').doc(id).get();
  const doc = data?.[0];
  if (!doc) return;

  currentArticle = doc;
  editBaseUpdatedAt = doc.updated_at;

  $('#header-title').textContent = doc.title || '(未命名)';
  hide($('#welcome-view')); show($('#article-view'));
  $('#btn-edit').classList.toggle('hidden', doc.type !== 'text');
  $('#btn-save').classList.toggle('hidden', doc.type !== 'text');
  $('#btn-export-article').classList.remove('hidden');
  $('#btn-delete').classList.remove('hidden');

  if (doc.type === 'text') {
    show($('#richtext-editor-view')); hide($('#pdf-reader-view'));
    quill.setContents(doc.content ? JSON.parse(doc.content) : []);
    // 尝试加载本地草稿
    const draftKey = `draft:${doc._id}`;
    const localDraft = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (localDraft && (!doc.updated_at || localDraft.updated_at > doc.updated_at)) {
      quill.setContents(localDraft.delta);
      showToast('已加载本地草稿');
    }
  } else {
    hide($('#richtext-editor-view')); show($('#pdf-reader-view'));
    await renderPDF(doc);
  }
}

// 删除文章
$('#btn-delete').addEventListener('click', async () => {
  if (!currentArticle) return;
  if (!confirm('确定删除当前文章？')) return;
  await db.collection('articles').doc(currentArticle._id).remove();
  currentArticle = null;
  show($('#welcome-view')); hide($('#article-view'));
  await reloadFileTree();
  showToast('已删除');
});

// ----------------- 富文本编辑 & 图片上传 -----------------
function initQuill() {
  if (quill) return;
  quill = new Quill('#editor', {
    theme: 'snow',
    modules: { toolbar: '#toolbar' }
  });

  // 插入图片：打开文件选择
  $('#btn-insert-image').addEventListener('click', (e) => {
    e.preventDefault();
    $('#image-input').click();
  });
  $('#image-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = await uploadToCOS(file);
    const range = quill.getSelection(true);
    quill.insertEmbed(range.index, 'image', url, 'user');
    quill.setSelection(range.index + 1);
  });

  // 本地草稿（节流）
  const saveDraft = throttle(() => {
    if (!currentArticle) return;
    const draftKey = `draft:${currentArticle._id}`;
    localStorage.setItem(draftKey, JSON.stringify({
      updated_at: Date.now(),
      delta: quill.getContents()
    }));
  }, 1200);
  quill.on('text-change', saveDraft);
}

// 保存文章（冲突检测 + 服务端保存）
$('#btn-save').addEventListener('click', async () => {
  if (!currentArticle) return;
  // 冲突检测：重新取一次
  const latest = await db.collection('articles').doc(currentArticle._id).get();
  const cloud = latest.data?.[0];
  if (cloud && cloud.updated_at !== editBaseUpdatedAt) {
    // 冲突：把当前草稿复制到剪贴板 & 载入云端版本
    const text = JSON.stringify(quill.getContents());
    try { await navigator.clipboard.writeText(text); } catch {}
    showToast('检测到他处已更新，已复制你的草稿到剪贴板');
    quill.setContents(cloud.content ? JSON.parse(cloud.content) : []);
    currentArticle = cloud;
    editBaseUpdatedAt = cloud.updated_at;
    return;
  }

  const delta = quill.getContents();
  await db.collection('articles').doc(currentArticle._id).update({
    content: JSON.stringify(delta),
    updated_at: nowISO()
  });
  editBaseUpdatedAt = nowISO();
  await reloadFileTree();
  showToast('已保存');
});

// 上传图片 / PDF 到 COS
async function uploadToCOS(file, keyPrefix = `${currentUser.uid}/`) {
  // Key：<uid>/<文件名>
  const Key = keyPrefix + `${Date.now()}_${file.name}`;
  await new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: CONFIG.COS_BUCKET,
      Region: CONFIG.COS_REGION,
      Key,
      Body: file
    }, (err, data) => err ? reject(err) : resolve(data));
  });
  // 直链（公有读），若桶不是公有读，你可以用临时签名 URL
  return `https://${CONFIG.COS_BUCKET}.cos.${CONFIG.COS_REGION}.myqcloud.com/${encodeURIComponent(Key)}`;
}

// ----------------- PDF 导入与阅读 -----------------
$('#pdf-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  // 1) 上传 PDF
  const url = await uploadToCOS(file);
  // 2) 写入一条 PDF 类型文章
  const title = file.name.replace(/\.pdf$/i, '');
  const res = await db.collection('articles').add({
    title, user_id: currentUser.uid, type: 'pdf', pdf_url: url, created_at: nowISO(), updated_at: nowISO()
  });
  await reloadFileTree();
  await openArticle(res.id);
  showToast('PDF 已导入');
});

async function renderPDF(doc) {
  const container = $('#pdf-reader-view');
  container.innerHTML = '';
  hide($('#pdf-controls'));
  try {
    const pdf = await pdfjsLib.getDocument(doc.pdf_url).promise; // 参考：
    let pageNum = 1;
    const renderPage = async (num) => {
      const page = await pdf.getPage(num);
      const viewport = page.getViewport({ scale: 1.2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      container.innerHTML = ''; container.appendChild(canvas);
      $('#pdf-pageinfo').textContent = `${num} / ${pdf.numPages}`;
    };
    show($('#pdf-controls'));
    $('#pdf-prev').onclick = () => { if (pageNum > 1) renderPage(--pageNum) };
    $('#pdf-next').onclick = () => { if (pageNum < pdf.numPages) renderPage(++pageNum) };
    await renderPage(pageNum);
  } catch (e) {
    console.error(e);
    container.innerHTML = '<div class="text-sm text-red-500">PDF 加载失败</div>';
  }
}

// ----------------- 导入/导出备份 -----------------
$('#btn-export').addEventListener('click', async () => {
  const [fs, as] = await Promise.all([
    db.collection('folders').where({ user_id: currentUser.uid }).get(),
    db.collection('articles').where({ user_id: currentUser.uid }).get(),
  ]);
  const json = JSON.stringify({ folders: fs.data, articles: as.data }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `backup_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('已导出');
});

$('#backup-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('导入备份会清空你现有的云端数据，是否继续？')) return;
  const text = await file.text();
  const data = JSON.parse(text);
  // 清空当前用户数据
  const colls = ['folders', 'articles'];
  for (const c of colls) {
    const all = await db.collection(c).where({ user_id: currentUser.uid }).get();
    for (const d of all.data) await db.collection(c).doc(d._id).remove();
  }
  // 写入
  for (const f of (data.folders || [])) {
    delete f._id; await db.collection('folders').add({ ...f, user_id: currentUser.uid });
  }
  for (const a of (data.articles || [])) {
    delete a._id; await db.collection('articles').add({ ...a, user_id: currentUser.uid });
  }
  await reloadFileTree();
  showToast('导入完成');
});

// ----------------- 文章导出 -----------------
$('#btn-export-article').addEventListener('click', async () => {
  if (!currentArticle) return;
  if (currentArticle.type === 'pdf') {
    // 直接下载 PDF
    window.open(currentArticle.pdf_url, '_blank');
    return;
  }
  // 导出为 .txt
  const txt = quill.getText();
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (currentArticle.title || 'note') + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});

// 启动入口：若已登录则触发 afterAuthReady
(async () => {
  const state = await auth.getLoginState();
  if (state) {
    currentUser = state.user || state;
    await afterAuthReady();
  } else {
    show($('#auth-view'));
  }
})();
