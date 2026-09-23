"""Real native engine + collector, fake RPC only; no process/model/network."""
import base64
import copy
import importlib.util
from pathlib import Path
import threading
import unittest

ROOT = Path(__file__).parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
f = load("native_fixtures", "rm-0032-native-conversation.test.py")
c = load("collector", "rm-0032-native-image-collector.py")
e = load("epoch", "rm-0032-native-image-epoch.py")
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==")

def image(turn, status="completed"):
    return {"id": "image-" + turn, "type": "imageGeneration", "status": status,
            "result": base64.b64encode(PNG).decode() if status == "completed" else ""}

def images(turn):
    return [
        {"method": "item/started", "params": {"threadId": "thread-1", "turnId": turn, "startedAtMs": 1, "item": image(turn, "in_progress")}},
        {"method": "item/completed", "params": {"threadId": "thread-1", "turnId": turn, "completedAtMs": 2, "item": image(turn)}},
        f.completed(turn, "Картинка", [image(turn), f.message(turn, "Картинка")]),
    ]

def epoch(rpc=None, tool=None, clock=None):
    return e.create_native_image_epoch(f.m, c, f.SOURCE, profile=f.PROFILE, cwd=f.CWD,
        tool_spec=copy.deepcopy(f.SPEC), instructions="Neurobro answers text or makes an image; reads only bound-group history.",
        rpc=rpc or f.Rpc(), tool=tool or (lambda *_: copy.deepcopy(f.RESULT)), **({"clock":clock} if clock else {}))


class EpochTests(unittest.TestCase):
    def test_owner_close_before_budget_is_cancelled_not_deadline(self):
        now=[100.0];rpc=f.Rpc();actor=epoch(rpc,clock=lambda:now[0])
        original=rpc.next_frame
        def close_during_wait(seconds):
            now[0]=163.6;actor.close();return original(seconds)
        rpc.next_frame=close_during_wait
        value=actor.turn('close-before-deadline','Synthetic')
        self.assertEqual(value['metadata']['outcome'],'unknown')
        self.assertEqual(value['metadata']['failureSite'],'cancelled')
        self.assertEqual(value['metadata']['code'],'TRANSPORT_UNKNOWN')
        self.assertTrue(value['metadata']['sessionPoisoned'])

    def test_close_does_not_overwrite_prior_native_failure(self):
        rpc=f.Rpc();actor=epoch(rpc)
        def fail_then_close(seconds):
            try:raise f.m.Refused('PROTOCOL_REFUSED','events')
            finally:actor.close()
        rpc.next_frame=fail_then_close
        value=actor.turn('original-failure','Synthetic')
        self.assertEqual(value['metadata']['code'],'PROTOCOL_REFUSED')
        self.assertEqual(value['metadata']['failureSite'],'events')
        self.assertEqual(value['metadata']['outcome'],'unknown')

    def test_terminal_generation_failure_is_truthful_releasable_text_without_replay(self):
        for failure, original in ((failure, original) for failure in (None, {"type":"usageLimitExceeded", "limitId":"private-limit"})
                for original in ("Готово! Аватар изменён.", "я" * 1800)):
            def plan(turn):
                terminal = image(turn, "failed")
                if failure is not None: terminal["failure"] = copy.deepcopy(failure)
                return [
                    {"method":"item/started", "params":{"threadId":"thread-1", "turnId":turn, "startedAtMs":1, "item":image(turn,"in_progress")}},
                    {"method":"item/completed", "params":{"threadId":"thread-1", "turnId":turn, "completedAtMs":2, "item":terminal}},
                    f.completed(turn, items=[terminal, f.message(turn,original)]),
                ]
            rpc=f.Rpc(plan);actor=epoch(rpc)
            value=actor.turn("failed-image", "Нарисуй")
            self.assertEqual(value["metadata"]["code"], "OK")
            self.assertEqual(value["metadata"]["outcome"], "observed")
            self.assertEqual(value["imageMetadata"]["outcome"], "failed")
            self.assertEqual(value["imageMetadata"]["failureCode"], "usageLimitExceeded" if failure else "generationFailed")
            self.assertFalse(value["imageMetadata"]["exportReady"])
            self.assertEqual(value["answer"], "Не удалось получить готовую картинку: достигнут лимит генерации изображений." if failure else
                "Не удалось получить готовую картинку: генерация завершилась с ошибкой.")
            self.assertNotIn("private-limit", value["answer"])
            self.assertLessEqual(len(value["answer"].encode()),1024)
            self.assertEqual(value["metadata"]["answerBytes"],len(value["answer"].encode("utf-8")))
            self.assertNotEqual(value["metadata"]["answerBytes"],len(original.encode("utf-8")))
            self.assertTrue(actor.state()["releasePending"])
            self.assertFalse(actor.state()["poisoned"])
            self.assertEqual(actor.completed_turn_scope()["requestRef"],"failed-image")
            with self.assertRaises(e.EpochError):actor.image_artifact()
            with self.assertRaises(e.EpochError):list(actor.image_frames())
            self.assertEqual(actor.turn("fresh", "Новый запрос")["metadata"]["code"],"BUSY")
            self.assertEqual(rpc.turn,1)
            actor.releaseTurn("failed-image","verified")
            self.assertEqual(actor.turn("failed-image", "Повтори")["metadata"]["code"],"INPUT_REFUSED")
            rpc.plan=lambda turn:[f.completed(turn)]
            self.assertEqual(actor.turn("fresh", "Новый запрос")["metadata"]["code"],"OK")
            self.assertEqual(rpc.turn,2)

    def test_generation_failure_does_not_mask_unfinished_tool_or_invalid_lifecycle(self):
        for broken in ("missing-start", "missing-terminal", "failed-turn", "missing-answer", "unfinished-tool", "conflicting-image"):
            def plan(turn):
                terminal=image(turn,"failed")
                events=[
                    {"method":"item/started", "params":{"threadId":"thread-1", "turnId":turn, "startedAtMs":1, "item":image(turn,"in_progress")}},
                    {"method":"item/completed", "params":{"threadId":"thread-1", "turnId":turn, "completedAtMs":2, "item":terminal}},
                    f.completed(turn,items=[terminal,f.message(turn,"Готово")]),
                ]
                if broken=="missing-start":events.pop(0)
                if broken=="missing-terminal":events.pop(1)
                if broken=="failed-turn":events[-1]["params"]["turn"]["status"]="failed"
                if broken=="missing-answer":events[-1]["params"]["turn"]["items"]=[terminal]
                if broken=="unfinished-tool":events.insert(0,f.request(turn))
                if broken=="conflicting-image":events[-1]["params"]["turn"]["items"][0]=image(turn)
                return events
            rpc=f.Rpc(plan);rpc.auto_terminal=False
            actor=epoch(rpc);value=actor.turn("broken", "Запрос")
            self.assertEqual(value["metadata"]["outcome"],"unknown",broken)
            self.assertIsNone(value["answer"],broken)
            self.assertTrue(actor.state()["poisoned"],broken)
            self.assertFalse(value["imageMetadata"]["exportReady"],broken)
            self.assertEqual(actor.turn("later","Позже")["metadata"]["code"],"SESSION_POISONED",broken)
            self.assertEqual(rpc.turn,1)

    def test_failed_generation_passes_actual_scoped_session_as_text_and_releases(self):
        fixture=load("failed_image_scoped_session", "rm-0032-native-scoped-epoch.test.py")
        def plan(turn):
            if turn != "turn-1": return [f.completed(turn)]
            terminal=image(turn,"failed")
            return [f.request(turn),
                {"method":"item/started", "params":{"threadId":"thread-1", "turnId":turn, "startedAtMs":1, "item":image(turn,"in_progress")}},
                {"method":"item/completed", "params":{"threadId":"thread-1", "turnId":turn, "completedAtMs":2, "item":terminal}},
                f.completed(turn,items=[terminal,f.message(turn,"Готово")])]
        host=fixture.Host(("conversation","conversation"),plan=plan)
        closed=host.run()
        self.assertEqual(closed["code"],"CLOSED",closed)
        completed=[frame for frame in host.frames if frame["kind"]=="completed"]
        self.assertEqual(len(completed),2)
        self.assertEqual(completed[0]["kindOfAnswer"],"text")
        self.assertEqual(completed[0]["answer"],"Не удалось получить готовую картинку: генерация завершилась с ошибкой.")
        self.assertEqual(completed[0]["toolCalls"],1)
        self.assertFalse(any(frame["kind"].startswith("image") for frame in host.frames))
        self.assertEqual(len([frame for frame in host.frames if frame["kind"]=="released"]),2)
        self.assertEqual(host.rpc.turn,2)
        self.assertFalse(closed["facts"]["unreleasedTurn"])

    def test_incoming_pixels_reach_actual_turn_start_then_are_not_reused(self):
        rpc=f.Rpc();actor=epoch(rpc)
        encoded=base64.b64encode(PNG).decode()
        result=actor.turn("photo", "Describe the attached photo", [{"mimeType":"image/png","base64":encoded}])
        self.assertEqual(result["metadata"]["outcome"],"observed")
        params=next(p for method,p in rpc.calls if method=="turn/start")
        self.assertEqual(params["input"][1],{"type":"image","url":"data:image/png;base64,"+encoded})
        self.assertEqual(len(params["input"]),2)
        actor.releaseTurn("photo","not-sent")
        actor.turn("text", "Next ordinary request")
        self.assertEqual(len(rpc.calls[-1][1]["input"]),1)
        self.assertEqual(actor._visual_inputs,[])

    def test_maximum_pixel_bytes_fit_actual_native_rpc_image_frame_profile(self):
        rpc=f.Rpc();actor=epoch(rpc)
        raw=PNG+b"x"*(8*1024*1024-len(PNG))
        encoded=base64.b64encode(raw).decode()
        result=actor.turn("maximum", "Describe", [{"mimeType":"image/png","base64":encoded}])
        self.assertEqual(result["metadata"]["outcome"],"observed")
        params=next(p for method,p in rpc.calls if method=="turn/start")
        transport=load("rpc_image_profile","rm-0032-native-rpc.py")
        wire=transport.encode_frame({"id":1,"method":"turn/start","params":params},profile="image")
        self.assertLess(len(wire),12*1024*1024)
        self.assertEqual(base64.b64decode(params["input"][1]["url"].split(",",1)[1]),raw)

    def test_large_admitted_jpeg_echo_ack_and_all_notifications_keep_ordinary_budget(self):
        for size in (324,400000,2*1024*1024):
            class Echo(f.Rpc):
                def exchange(rpc,method,params,timeout):
                    result,error=super().exchange(method,params,timeout)
                    if method=="turn/start":
                        item={"id":"user-1","type":"userMessage","content":copy.deepcopy(params["input"])}
                        result["turn"]["items"]=[copy.deepcopy(item)]
                        rpc.frames=[{"method":method,"params":{"threadId":"thread-1","turnId":"turn-1",timestamp:1,"item":copy.deepcopy(item)}} for method,timestamp in (("item/started","startedAtMs"),("item/completed","completedAtMs"))]
                        rpc.frames.insert(0,{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress","items":[copy.deepcopy(item)]}}})
                        rpc.frames.append(f.completed("turn-1",items=[copy.deepcopy(item),f.message("turn-1")]))
                    return result,error
            rpc=Echo();actor=epoch(rpc);raw=b"\xff\xd8\xff"+b"x"*(size-3)
            images=[{"mimeType":"image/jpeg","base64":base64.b64encode(raw).decode()}]
            if size>324:images.append({"mimeType":"image/jpeg","base64":base64.b64encode(raw[:-1]+b"y").decode()})
            result=actor.turn("photo","Describe image",images)
            self.assertEqual(result["metadata"]["code"],"OK",result["metadata"])
            self.assertLess(result["metadata"]["eventBytes"],10000)
            self.assertGreater(actor._input_echo_wire,size*5*len(images))
            self.assertEqual(actor._visual_inputs,[])
            old={"id":"old-user","type":"userMessage","content":copy.deepcopy(rpc.calls[-1][1]["input"])}
            projected=actor._project({"turn":{"items":[old]}},[old])
            self.assertEqual(projected["turn"]["items"][0]["content"][1]["url"],old["content"][1]["url"])

    def test_image_echo_projection_never_hides_foreign_images_or_large_text(self):
        raw=b"\xff\xd8\xff"+b"x"*400000
        for kind in ("foreign-url","large-text","unknown-field","extra-image"):
            class Echo(f.Rpc):
                def exchange(rpc,method,params,timeout):
                    result,error=super().exchange(method,params,timeout)
                    if method=="turn/start":
                        item={"id":"user-1","type":"userMessage","content":copy.deepcopy(params["input"])}
                        if kind=="foreign-url":item["content"][1]["url"]+="foreign"
                        if kind=="large-text":item["content"][0]["text"]="x"*300000
                        if kind=="unknown-field":item["content"][1]["unexpected"]="x"*300000
                        if kind=="extra-image":item["content"].append(copy.deepcopy(item["content"][1]))
                        result["turn"]["items"]=[item]
                    return result,error
            result=epoch(Echo()).turn("photo","Describe",[{"mimeType":"image/jpeg","base64":base64.b64encode(raw).decode()}])
            self.assertEqual(result["metadata"]["code"],"BOUNDS_REFUSED",kind)

    def test_echo_lifecycle_bound_and_projection_preserves_metadata(self):
        actor=epoch();url="data:image/jpeg;base64,"+base64.b64encode(b"\xff\xd8\xff"+b"x"*400000).decode()
        actor._visual_inputs=[{"type":"image","url":url}];actor._input_echo_wire=0
        item={"id":"user-1","type":"userMessage","content":[{"type":"text","text":"unchanged"},{"type":"image","url":url,"detail":"high"}],"clientId":"client-1"}
        original=copy.deepcopy(item)
        frame={"turn":{"id":"turn-1","items":[item]}}
        projected=actor._project(frame,[item])
        self.assertEqual(item,original)
        kept=projected["turn"]["items"][0]
        self.assertEqual(kept["content"][0],original["content"][0]);self.assertEqual(kept["id"],"user-1")
        self.assertEqual(kept["content"][1],{"type":"image","url":"[host-admitted-image]","detail":"high"})
        accepted=1
        while actor._input_echo_wire+len(url.encode())<=e.INPUT_ECHO_LIFECYCLE_BYTES:
            actor._project(frame,[item]);accepted+=1
        self.assertGreater(accepted,100)
        with self.assertRaises(f.m.Refused):actor._project(frame,[item])

    def test_incoming_visual_refusal_never_admits_native_request(self):
        encoded=base64.b64encode(PNG).decode()
        good={"mimeType":"image/png","base64":encoded}
        for images in ([],[good]*3,[{"mimeType":"image/png","base64":"/secret.png"}],
                       [{"mimeType":"image/png","base64":encoded+"\n"}],
                       [{"mimeType":"image/jpeg","base64":encoded}],
                       [{**good,"path":"/secret.png"}],
                       [{"mimeType":"image/png","base64":base64.b64encode(PNG+b"x"*(8*1024*1024)).decode()}]):
            rpc=f.Rpc();actor=epoch(rpc)
            result=actor.turn("bad", "Describe", images)
            self.assertEqual(result["metadata"]["code"],"INPUT_REFUSED")
            self.assertEqual(rpc.calls,[])
            self.assertEqual(actor.state()["turnsAdmitted"],0)

    def test_text_history_image_text_same_thread_with_exact_native_id(self):
        calls=[]
        def plan(turn):
            if turn == "turn-2": return [f.request(turn, 2**63-1, "history-2"), f.completed(turn)]
            if turn == "turn-3": return images(turn)
            return [f.completed(turn)]
        def tool(params, seconds):
            calls.append((params,seconds));return copy.deepcopy(f.RESULT)
        rpc=f.Rpc(plan);actor=epoch(rpc,tool)
        for index in range(1,5):
            ref="request-"+str(index)
            value=actor.turn(ref,"Запрос "+str(index))
            self.assertEqual(value["metadata"]["outcome"],"observed")
            self.assertTrue(value["epochMetadata"]["releasePending"])
            self.assertFalse(value["epochMetadata"]["resourceSettlementObserved"])
            scope=actor.completed_turn_scope()
            self.assertEqual(scope,{"requestRef":ref,"threadId":"thread-1","turnId":"turn-"+str(index),"turnNumber":index})
            self.assertNotIn("requestRef",value["epochMetadata"])
            if index==3:
                artifact=actor.image_artifact()
                self.assertEqual(artifact["origin"],{"requestRef":ref,"threadId":"thread-1","turnId":"turn-3","itemId":"image-turn-3"})
                self.assertTrue(all(artifact["origin"][key]==scope[key] for key in ("requestRef","threadId","turnId")))
                frames=list(actor.image_frames());self.assertEqual(base64.b64decode(frames[1]["dataBase64"]),PNG)
            else:
                self.assertFalse(value["imageMetadata"]["exportReady"])
                with self.assertRaises(e.EpochError):actor.image_artifact()
            actor.releaseTurn(ref,"verified")
            with self.assertRaises(e.EpochError):actor.completed_turn_scope()
        self.assertEqual([method for method,_ in rpc.calls],["thread/start"]+["turn/start"]*4)
        self.assertEqual(calls[0][0]["requestId"],2**63-1);self.assertIs(type(calls[0][0]["requestId"]),int)
        self.assertEqual(rpc.responses[0][0],2**63-1)
        self.assertEqual(actor.state()["turnsAdmitted"],4)

    def test_next_turn_requires_exact_release_and_request_refs_are_not_reused(self):
        rpc=f.Rpc();actor=epoch(rpc)
        actor.turn("first","Привет")
        self.assertEqual(actor.turn("second","Второй")["metadata"]["code"],"BUSY")
        with self.assertRaises(e.EpochError):actor.releaseTurn("foreign","verified")
        with self.assertRaises(e.EpochError):actor.releaseTurn("first","sent-maybe")
        actor.releaseTurn("first","not-sent")
        self.assertEqual(actor.turn("first","Повтор")["metadata"]["code"],"INPUT_REFUSED")
        self.assertEqual(actor.turn("second","Второй")["metadata"]["code"],"OK")
        self.assertEqual(len(rpc.calls),3)
        with self.assertRaises(e.EpochError):actor.run("bypass")

    def test_release_revokes_prior_image_and_generator_before_next_image(self):
        actor=epoch(f.Rpc(images));actor.turn("image-request-1","Нарисуй")
        unstarted=actor.image_frames()
        iterator=actor.image_frames();self.assertEqual(next(iterator)["kind"],"imageBegin")
        actor.releaseTurn("image-request-1","verified")
        with self.assertRaises(e.EpochError):next(iterator)
        with self.assertRaises(e.EpochError):actor.image_artifact()
        value=actor.turn("image-request-2","Еще")
        self.assertEqual(value["metadata"]["code"],"OK")
        self.assertEqual(actor.image_artifact()["origin"]["requestRef"],"image-request-2")
        with self.assertRaises(e.EpochError):next(unstarted)
        actor.close()
        with self.assertRaises(e.EpochError):actor.image_artifact()

    def test_completed_scope_unavailable_before_turn_after_close_or_unknown(self):
        actor=epoch()
        with self.assertRaises(e.EpochError):actor.completed_turn_scope()
        actor.turn("one","Текст");actor.close()
        with self.assertRaises(e.EpochError):actor.completed_turn_scope()
        actor=epoch(f.Rpc(lambda turn:[f.completed("foreign-turn")]))
        self.assertEqual(actor.turn("failed","Запрос")["metadata"]["outcome"],"unknown")
        with self.assertRaises(e.EpochError):actor.completed_turn_scope()

    def test_unknown_delivery_poison_and_no_replay(self):
        rpc=f.Rpc();actor=epoch(rpc);actor.turn("one","Первый")
        state=actor.releaseTurn("one","unknown")
        self.assertTrue(state["poisoned"])
        with self.assertRaises(e.EpochError):actor.completed_turn_scope()
        self.assertEqual(actor.turn("two","Второй")["metadata"]["code"],"SESSION_POISONED")
        self.assertEqual(len(rpc.calls),2)

    def test_partial_image_and_foreign_or_late_events_poison(self):
        cases=[lambda turn: images(turn)[:1]+[f.completed(turn)],
               lambda turn: [{"method":"item/completed","params":{"threadId":"foreign","turnId":turn,"completedAtMs":1,"item":image(turn)}}],
               lambda turn: [f.completed("turn-previous")]]
        for plan in cases:
            with self.subTest(plan=cases.index(plan)):
                rpc=f.Rpc(plan);actor=epoch(rpc);value=actor.turn("one","Запрос")
                self.assertEqual(value["metadata"]["outcome"],"unknown")
                self.assertTrue(actor.state()["poisoned"])
                self.assertEqual(actor.turn("two","Еще")["metadata"]["code"],"SESSION_POISONED")
                with self.assertRaises(e.EpochError):actor.image_artifact()

    def test_time_budget_admits_exactly_full_300_seconds(self):
        now=[0.0];rpc=f.Rpc();actor=epoch(rpc,clock=lambda:now[0]);now[0]=600.0
        self.assertEqual(actor.turn("one","На границе")["metadata"]["code"],"OK")
        actor.releaseTurn("one","verified");now[0]=600.001
        before=actor.state()
        self.assertEqual(actor.turn("two","Позже"),{"kind":"notAdmitted","requestRef":"two","reason":"time","turnsAdmitted":1})
        self.assertEqual(actor.state(),before)
        self.assertEqual(len(rpc.calls),2)

    def test_epoch_deadline_also_revokes_unexported_artifact(self):
        now=[0.0];actor=epoch(f.Rpc(images),clock=lambda:now[0])
        actor.turn("one","Картинка");iterator=actor.image_frames();now[0]=900
        with self.assertRaises(e.EpochError):actor.image_artifact()
        with self.assertRaises(e.EpochError):next(iterator)

    def test_sixteen_turn_limit_no_unbounded_ref_registry(self):
        actor=epoch(clock=lambda:0)
        for i in range(16):
            ref=str(i);self.assertEqual(actor.turn(ref,"Текст")["metadata"]["code"],"OK");actor.releaseTurn(ref,"verified")
        self.assertEqual(actor.turn("17","Текст"),{"kind":"notAdmitted","requestRef":"17","reason":"turns","turnsAdmitted":16})
        self.assertEqual(actor.state()["turnsAdmitted"],16)

    def test_closed_or_poisoned_epoch_never_mints_time_refusal(self):
        for closed in (False,True):
            now=[0.0];rpc=f.Rpc();actor=epoch(rpc,clock=lambda:now[0]);now[0]=601
            if closed:actor.close()
            else:actor._poisoned=True
            self.assertEqual(actor.turn("one","Запрос")["metadata"]["code"],"SESSION_POISONED")
            self.assertEqual(rpc.calls,[])

    def test_actual_turn_deadline_includes_first_thread_start(self):
        now=[0.0]
        class Slow(f.Rpc):
            def exchange(self,method,params,seconds):
                result=super().exchange(method,params,seconds)
                if method=="thread/start":now[0]=301
                return result
        rpc=Slow();actor=epoch(rpc,clock=lambda:now[0])
        value=actor.turn("one","Запрос")
        self.assertEqual(value["metadata"]["outcome"],"unknown")
        self.assertTrue(actor.state()["poisoned"])
        self.assertEqual([method for method,_ in rpc.calls],["thread/start"])

    def test_close_and_release_during_running_turn_do_not_claim_settlement(self):
        entered,resume=threading.Event(),threading.Event()
        class Blocking(f.Rpc):
            def next_frame(self,seconds):
                entered.set()
                if not resume.wait(2):raise TimeoutError("fixture")
                return super().next_frame(seconds)
        actor=epoch(Blocking());results=[]
        worker=threading.Thread(target=lambda:results.append(actor.turn("one","Запрос")))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(actor.turn("two","Параллельный")["metadata"]["code"],"BUSY")
            with self.assertRaises(e.EpochError):actor.releaseTurn("one","verified")
            state=actor.close();self.assertTrue(state["closed"]);self.assertTrue(state["running"])
            self.assertFalse(state["resourceSettlementObserved"])
        finally:resume.set();worker.join(2)
        self.assertFalse(worker.is_alive());self.assertIsNone(results[0]["answer"])
        self.assertEqual(results[0]["metadata"]["outcome"],"unknown")
        self.assertFalse(actor.state()["running"])

    def test_concurrent_release_and_close_revoke_exports(self):
        actor=epoch(f.Rpc(images));actor.turn("one","Картинка")
        barrier=threading.Barrier(2);errors=[]
        def release():
            barrier.wait()
            try:actor.releaseTurn("one","verified")
            except e.EpochError as error:errors.append(error.code)
        worker=threading.Thread(target=release);worker.start();barrier.wait();actor.close();worker.join(2)
        self.assertFalse(worker.is_alive());self.assertTrue(all(code=="closed" for code in errors))
        self.assertTrue(actor.state()["closed"])
        with self.assertRaises(e.EpochError):list(actor.image_frames())



class CommunityImageRefusalTests(unittest.TestCase):
    def actor(self, rpc):
        return e.create_native_image_epoch(f.m,c,f.SOURCE,profile=f.PROFILE,cwd=f.CWD,tool_spec=copy.deepcopy(f.SPEC),
            instructions='Assess supplied text.',rpc=rpc,tool=lambda *_:self.fail('No community callback'),
            isolation_mode='community-assessment',thread_config={'web_search':'disabled','features.image_generation':False})
    def test_valid_image_input_refused_before_admission(self):
        rpc=f.Rpc();actor=self.actor(rpc)
        value=actor.turn('one','Assess',[{'mimeType':'image/png','base64':base64.b64encode(PNG).decode()}])
        self.assertEqual(value['metadata']['code'],'INPUT_REFUSED');self.assertEqual(rpc.calls,[])
        self.assertEqual(actor.state()['turnsAdmitted'],0)
    def test_valid_image_lifecycle_rejected_for_notification_and_turn_ack(self):
        for acknowledgement in (False,True):
            rpc=f.Rpc(images);actor=self.actor(rpc)
            if acknowledgement:
                original=rpc.exchange
                def exchange(method,params,seconds):
                    result,error=original(method,params,seconds)
                    if method=='turn/start':result['turn']['items']=[image(result['turn']['id'])]
                    return result,error
                rpc.exchange=exchange
            value=actor.turn('one','Assess')
            self.assertEqual(value['metadata']['code'],'TOOL_REFUSED',value)
            self.assertTrue(actor.state()['poisoned']);self.assertFalse(value['imageMetadata']['exportReady'])
            with self.assertRaises(e.EpochError):list(actor.image_frames())

if __name__ == "__main__":unittest.main()
