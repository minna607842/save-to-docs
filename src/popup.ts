interface URLState {
  lastIndex: number;
  lastUpdateTime: number;
}

interface DocumentState {
  lastIndex: number;
  documentId: string;
  urlStates: {
    [url: string]: URLState;
  };
}

document.addEventListener('DOMContentLoaded', () => {
  const mainView = document.getElementById('mainView');
  const setupView = document.getElementById('setupView');
  const saveButton = document.getElementById('saveButton');
  const setupButton = document.getElementById('setupButton');
  const createNewDoc = document.getElementById('createNewDoc');
  const docIdInput = document.getElementById('docIdInput') as HTMLInputElement;
  const errorText = document.getElementById('errorText');
  const resetUrlsButton = document.getElementById('resetUrlsButton');

  console.log('DOM Loaded');

  // 新規ドキュメント作成
  async function createDocument() {
    try {
      console.log('Creating new document');
      const token = await chrome.identity.getAuthToken({ interactive: true });
      const response = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Web Page Archives'
        })
      });

      if (!response.ok) throw new Error('ドキュメントの作成に失敗しました');

      const doc = await response.json();
      // documentStateの初期化を追加
      await chrome.storage.local.set({
        documentId: doc.documentId,
        documentState: {
          lastIndex: 1,
          documentId: doc.documentId,
          urlStates: {}
        }
      });
      alert(`新規ドキュメントを作成しました！\nDocument ID: ${doc.documentId}`);
      await checkDocId();
    } catch (err) {
      console.error('Error creating document:', err);
      errorText!.textContent = err instanceof Error ? err.message : '不明なエラーが発生しました';
    }
  }

  // ドキュメントIDのチェック
  async function checkDocId() {
    console.log('Checking Doc ID');
    const docId = await chrome.storage.local.get('documentId');
    console.log('Got Doc ID:', docId);

    if (!docId.documentId) {
      mainView!.style.display = 'none';
      setupView!.style.display = 'block';
    } else {
      mainView!.style.display = 'block';
      setupView!.style.display = 'none';
    }
    return docId.documentId;
  }

  // 保存処理の実装
  async function saveWebPage(documentId: string) {
    try {
      console.log('Starting save process with document ID:', documentId);

      // Google認証
      console.log('Attempting to get auth token...');
      const token = await chrome.identity.getAuthToken({ interactive: true })
        .catch(err => {
          console.error('Auth token error:', err);
          throw new Error('認証に失敗しました: ' + err.message);
        });
      console.log('Got auth token successfully');

      // タブ情報の取得
      console.log('Getting current tab info...');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        .catch(err => {
          console.error('Tab query error:', err);
          throw new Error('タブ情報の取得に失敗しました');
        });

      if (!tab.id) {
        console.error('No tab ID found');
        throw new Error('タブIDが見つかりません');
      }
      console.log('Got tab info:', tab.id);

      // ページ内容の取得
      console.log('Executing content script...');
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const selectedText = window.getSelection()?.toString() || '';
          return {
            title: document.title,
            content: selectedText || document.body.innerText,
            url: document.location.href,
            isSelection: !!selectedText
          };
        }
      }).catch(err => {
        console.error('Script execution error:', err);
        throw new Error('ページ内容の取得に失敗しました');
      });

      const pageData = result[0].result as {
        title: string;
        content: string;
        url: string;
        isSelection: boolean;
      };

      // URLチェックを行う
      const { savedUrls = [] } = await chrome.storage.local.get('savedUrls');
      console.log('Saved URLs:', savedUrls);
      console.log('Current URL:', pageData.url);
      const isUrlExists = savedUrls.includes(pageData.url);
      console.log('URL exists?:', isUrlExists);

      // 選択テキストの有無をログ出力
      console.log('Got page data:', {
        title: pageData.title.substring(0, 50) + '...',
        contentLength: pageData.content.length,
        url: pageData.url,
        isSelection: pageData.isSelection
      });

      // ドキュメントの状態を取得
      const { documentState = {
        lastIndex: 1,
        documentId,
        urlStates: {}
      } } = await chrome.storage.local.get('documentState');

      const currentTime = Date.now();
      const urlState = documentState.urlStates[pageData.url];
      const sixHours = 6 * 60 * 60 * 1000;

      let insertIndex = 1;
      let content;

      if (isUrlExists && urlState && (currentTime - urlState.lastUpdateTime) < sixHours) {
        insertIndex = documentState.lastIndex;
        content = `\n${pageData.content}\n`;

        const newIndex = insertIndex + content.length;
        documentState.lastIndex = newIndex;
        documentState.urlStates[pageData.url] = {
          lastIndex: insertIndex,
          lastUpdateTime: currentTime
        };
      } else {
        insertIndex = 1;
        content = `\n-------------------\n${new Date().toLocaleString()}\n${pageData.title}\n${pageData.url}\n${pageData.content}\n`;

        documentState.lastIndex = content.length + 1;
        documentState.urlStates[pageData.url] = {
          lastIndex: insertIndex,
          lastUpdateTime: currentTime
        };
      }

      // Google Docsに保存
      const updateResponse = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index: insertIndex },
                text: content
              }
            }
          ]
        })
      });

      if (!updateResponse.ok) {
        const errorData = await updateResponse.json();
        console.error('Google Docs API error:', errorData);
        throw new Error(`Google Docsへの保存に失敗しました: ${updateResponse.status} ${updateResponse.statusText}`);
      }

      // 状態の更新
      await chrome.storage.local.set({ documentState });

      // 保存成功後、URLを保存済みリストに追加
      if (!isUrlExists) {
        savedUrls.push(pageData.url);
        if (savedUrls.length > 1000) {
          savedUrls.splice(0, savedUrls.length - 1000);
        }
        await chrome.storage.local.set({ savedUrls });
      }

      console.log('Successfully saved to Google Docs');
      alert('保存が完了しました！');

    } catch (err) {
      console.error('Full error details:', err);
      const errorMessage = err instanceof Error ? err.message : '不明なエラーが発生しました';
      console.error('Formatted error message:', errorMessage);
      alert('エラーが発生しました: ' + errorMessage);
    }
  }

  // 設定画面のイベントリスナー
  setupButton?.addEventListener('click', async () => {
    console.log('Setup button clicked');
    const docId = docIdInput.value.trim();
    if (docId) {
      await chrome.storage.local.set({ documentId: docId });
      await checkDocId();
    } else {
      errorText!.textContent = 'Document IDを入力してください';
    }
  });

  createNewDoc?.addEventListener('click', createDocument);

  // saveButtonのイベントリスナーを追加
  if (saveButton) {
    saveButton.addEventListener('click', async () => {
      console.log('Save button clicked');
      const docId = await checkDocId();
      console.log('Got docId:', docId); // 追加
      if (docId) {
        await saveWebPage(docId);
      } else {
        console.log('No document ID configured');
        alert('Document IDが設定されていません');
      }
    });
  }

  // リセットボタンのイベントリスナーを追加
  resetUrlsButton?.addEventListener('click', async () => {
    try {
      const docId = await checkDocId();
      if (!docId) {
        alert('Document IDが設定されていません');
        return;
      }

      await chrome.storage.local.set({
        savedUrls: [],
        documentState: {
          lastIndex: 1,
          documentId: docId,
          urlStates: {}
        }
      });
      alert('URL履歴をリセットしました');
    } catch (err) {
      console.error('Error resetting URLs:', err);
      alert('リセット中にエラーが発生しました');
    }
  });

  // 初期チェック
  checkDocId().catch(console.error);
});