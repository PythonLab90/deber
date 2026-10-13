from django.urls import path

from . import views


app_name = "home"

urlpatterns = [
    path("", views.index, name="index"),
    path("upload/", views.upload_document, name="upload_document"),
    path("analyze/", views.analyze_document, name="analyze_document"),
    path("review/", views.review_document, name="review_document"),
    path("document/pdf/", views.preview_pdf, name="preview_pdf"),
    path("convert/", views.convert_document, name="convert_document"),
    path("extract/", views.extract_pdf, name="extract_pdf"),
    path("download-excel/", views.download_excel, name="download_excel"),
    path("ai-chat/", views.ai_chat, name="ai_chat"),
    path("schedule/", views.schedule_page, name="schedule_page"),
    path("schedule/preview/", views.preview_schedule_template, name="preview_schedule_template"),
    path("schedule/analyze/", views.analyze_schedule, name="analyze_schedule"),
    path("schedule/download/", views.download_completed_schedule, name="download_completed_schedule"),
]
