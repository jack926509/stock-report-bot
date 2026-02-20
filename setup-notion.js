/**
 * setup-notion.js — 一次性執行腳本
 * 在指定的 Notion 父頁面下建立「美股日報存檔」資料庫，並定義所有欄位。
 *
 * 執行方式：
 *   NOTION_API_KEY=ntn_xxx NOTION_PAGE_ID=xxxxxxxx node setup-notion.js
 *
 * 執行成功後會印出 NOTION_DATABASE_ID，
 * 請將其加入 Zeabur 環境變數 NOTION_DATABASE_ID=xxx
 */

'use strict';

const { Client } = require('@notionhq/client');

const NOTION_KEY     = process.env.NOTION_API_KEY;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || '30d21c6ed34080cc9683fbf5b75ef1b0';

if (!NOTION_KEY) {
  console.error('❌ 請設定環境變數 NOTION_API_KEY');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_KEY });

async function main() {
  console.log('🔨 正在 Notion 建立「美股日報存檔」資料庫...');

  const db = await notion.databases.create({
    parent: { page_id: NOTION_PAGE_ID },

    // 資料庫標題
    title: [{ type: 'text', text: { content: '📊 美股日報存檔' } }],

    // ─── 欄位定義 ────────────────────────────────────
    properties: {

      // ① 標題（必填，Notion title 欄位）
      '標題': { title: {} },

      // ② 日期
      '日期': { date: {} },

      // ③ 三大指數漲跌
      'S&P 500': { rich_text: {} },
      '道瓊':    { rich_text: {} },
      '那斯達克': { rich_text: {} },

      // ④ 恐慌指數
      'VIX': { number: { format: 'number' } },

      // ⑤ 市場情緒（自動派生自 SPX 漲跌幅）
      '市場情緒': {
        select: {
          options: [
            { name: '樂觀',   color: 'green'  },
            { name: '偏樂觀', color: 'blue'   },
            { name: '偏謹慎', color: 'orange' },
            { name: '悲觀',   color: 'red'    },
          ],
        },
      },

      // ⑥ 當日漲跌冠軍（全池個股）
      '漲幅冠軍': { rich_text: {} },
      '跌幅冠軍': { rich_text: {} },

      // ⑦ 報告字數（純文字，不含 HTML 標籤）
      '報告字數': { number: { format: 'number' } },
    },
  });

  console.log('');
  console.log('✅ 資料庫建立成功！');
  console.log('');
  console.log('請將以下 Database ID 加入 Zeabur 環境變數：');
  console.log('');
  console.log(`  NOTION_DATABASE_ID=${db.id}`);
  console.log('');
  console.log(`  Notion 資料庫連結：${db.url}`);
}

main().catch(err => {
  console.error('❌ 建立失敗：', err.message);
  if (err.code === 'object_not_found') {
    console.error('   → 請確認 NOTION_PAGE_ID 正確，且 Integration 已被授予頁面存取權');
  }
  process.exit(1);
});
