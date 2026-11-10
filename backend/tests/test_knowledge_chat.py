from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent import moonstone_knowledge as knowledge
from app.api import agent


class KnowledgeChatTests(unittest.TestCase):
    def test_retrieves_specific_topics_and_rejects_unrelated_queries(self):
        for query, expected in (
            ("月石是什么，怎么工作？", "product"),
            ("你是谁？", "assistant"),
            ("v5 模型有多大，能放到 ESP32 吗", "v5-deploy"),
            ("v5 跨集合召回率是多少", "v5-results"),
            ("DeepSeek 和豆包怎么分工？", "model-roles"),
            ("七晚收集完成会自动开启吗", "seven-nights"),
            ("鼾声音量和气道阻塞有关系吗？", "snore-loudness"),
            ("回声消除能解决白噪声干扰吗", "noise"),
            ("月石能诊断睡眠呼吸暂停吗", "medical-limits"),
            ("声音怎么定时关闭？", "sound-light"),
        ):
            with self.subTest(query=query):
                self.assertEqual(knowledge.retrieve(query)[0]["id"], expected)
        self.assertEqual(knowledge.retrieve("明天上海天气怎么样？"), [])

    def test_project_question_works_without_personal_records_and_has_real_citations(self):
        app = FastAPI()
        app.include_router(agent.router)
        model = AsyncMock(return_value='{"answer":"模型文件约 34 KB，目前候选固件未集成。","entry_ids":["v5-deploy"]}')
        with patch.object(agent, "require_user_device_access") as access, \
                patch.object(knowledge.config, "LLM_API_KEY", "fixture"), \
                patch.object(knowledge, "request_llm_chat", model), \
                patch.object(agent, "compute_daily_summary", side_effect=AssertionError("private records accessed")), \
                TestClient(app) as client:
            response = client.post("/api/v1/ai/chat", json={
                "device_id": "synthetic", "message": "自研 v5 模型多大？",
                "chat_history": [{"role": "user", "content": "private-report-fixture"}],
            })
        self.assertEqual(response.status_code, 200)
        access.assert_called_once()
        result = response.json()
        self.assertEqual(result["answer_kind"], "knowledge")
        self.assertEqual(result["source"], "llm_knowledge")
        self.assertEqual(result["knowledge_sources"][0]["id"], "model")
        self.assertNotIn("private-report-fixture", str(model.await_args))
        self.assertIn("34,336", str(model.await_args))

    def test_missing_or_invalid_citations_use_the_curated_answer(self):
        app = FastAPI()
        app.include_router(agent.router)
        with patch.object(agent, "require_user_device_access"), \
                patch.object(knowledge.config, "LLM_API_KEY", "fixture"), \
                patch.object(knowledge, "request_llm_chat", AsyncMock(return_value=
                    '{"answer":"可以保证改善睡眠","entry_ids":["invented-source"]}')), \
                TestClient(app) as client:
            result = client.post("/api/v1/ai/chat", json={
                "device_id": "synthetic", "message": "七晚采集完成会自动提醒吗？",
            }).json()
        self.assertEqual(result["source"], "curated_knowledge")
        self.assertIn("不会自动启动", result["answer"])
        self.assertNotIn("保证", result["answer"])

    def test_personal_and_urgent_routing(self):
        self.assertFalse(knowledge.is_project_question("我昨晚的鼾声等级是多少？", knowledge.retrieve("鼾声等级")))
        self.assertTrue(knowledge.is_project_question("月石什么时候上市？", []))
        app = FastAPI()
        app.include_router(agent.router)
        with patch.object(agent, "require_user_device_access"), \
                patch.object(knowledge, "request_llm_chat", AsyncMock(side_effect=AssertionError("model called"))), \
                patch.object(agent, "compute_daily_summary", side_effect=AssertionError("private records accessed")), \
                TestClient(app) as client:
            result = client.post("/api/v1/ai/chat", json={
                "device_id": "synthetic", "message": "我现在胸痛，月石能做什么？",
            }).json()
        self.assertEqual(result["safety_class"], "urgent")
        self.assertIn("立即联系当地急救", result["answer"])

    def test_out_of_scope_and_medication_questions_do_not_call_the_model(self):
        app = FastAPI()
        app.include_router(agent.router)
        with patch.object(agent, "require_user_device_access"), \
                patch.object(knowledge, "request_llm_chat", AsyncMock(side_effect=AssertionError("model called"))), \
                patch.object(agent, "compute_daily_summary", side_effect=AssertionError("private records accessed")), \
                TestClient(app) as client:
            for question, source in (
                ("月石什么时候正式上市？", "knowledge_no_match"),
                ("我应该吃什么药？", "rule_based_safety_fallback"),
            ):
                with self.subTest(question=question):
                    result = client.post("/api/v1/ai/chat", json={
                        "device_id": "synthetic", "message": question,
                    }).json()
                    self.assertEqual(result["source"], source)
                    self.assertFalse(result.get("knowledge_sources"))

